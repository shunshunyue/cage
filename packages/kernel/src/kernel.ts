// 内核：唯一的写入入口 execute。HTTP、审批流程、定时任务、反应、批量导入都调用它，
// 所以检查只写一遍，顺序永远一样（设计文档第 5 节的 12 关）。
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type DatabaseUrls, type DbHandle } from './db/connect.js';
import { diffFields, fieldsToColumns } from './db/rows.js';
import { setSessionVars } from './db/session.js';
import { CageError, cageError, isDomainError, toCageError } from './errors.js';
import { auditDiff, maskValue, present } from './mask.js';
import { loadUserGrants, systemCtx, userCtx } from './org.js';
import { bindReads, loadScoped } from './pipeline/load.js';
import { idempotency } from './pipeline/idempotency.js';
import type { AnyAggregate } from './primitives/aggregate.js';
import type { AnyCommand } from './primitives/command.js';
import type { ConstraintMeta } from './primitives/constraints.js';
import { type AnyEvent, defaultPayload } from './primitives/event.js';
import type { Fields } from './primitives/fields.js';
import { ReadSide } from './read.js';
import { buildRegistry, type RegisteredCommand, type Registry, type RegistryOptions } from './registry.js';
import { consoleLogger, type Logger, step, traceCarrier } from './telemetry.js';
import type { CapabilityParams, Ctx } from './types.js';

export interface KernelOptions {
  /** domain 包的导出（可以是多个模块，例如框架自带的组织模型 + 业务声明） */
  domain: object | object[];
  /** 数据库连接串；或者直接传入已有的连接 */
  urls?: DatabaseUrls;
  db?: { app: Kysely<any>; read: Kysely<any> };
  registryOptions?: RegistryOptions;
  logger?: Logger;
  /** 同事务反应的最大嵌套深度 */
  maxReactionDepth?: number;
  /** 连接池大小 */
  poolSize?: number;
}

export interface EmittedEvent {
  outboxId: number;
  event: string;
  payload: Record<string, unknown>;
}

export interface BatchResult {
  index: number;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; domainCode?: string; detail?: unknown };
}

export interface AuditEntry {
  tenantId: string;
  actor: string;
  actorKind: string;
  onBehalfOf?: string | null;
  source: string;
  kind: 'write' | 'read' | 'denied' | 'ops';
  capability?: string | null;
  command?: string | null;
  aggregate?: string | null;
  aggregateId?: string | null;
  result: string;
  diff?: unknown;
  requestId?: string | null;
  idempotencyKey?: string | null;
  client?: unknown;
}

function zodIssues(e: z.ZodError) {
  return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export class Kernel {
  readonly registry: Registry;
  readonly app: Kysely<any>;
  readonly readDb: Kysely<any>;
  readonly read: ReadSide;
  readonly log: Logger;
  private readonly handles: DbHandle[] = [];
  private readonly maxDepth: number;

  constructor(opts: KernelOptions) {
    this.registry = buildRegistry(opts.domain, opts.registryOptions);
    this.log = opts.logger ?? consoleLogger;
    this.maxDepth = opts.maxReactionDepth ?? 5;
    if (opts.db) {
      this.app = opts.db.app;
      this.readDb = opts.db.read;
    } else if (opts.urls) {
      const a = connect(opts.urls.app, { max: opts.poolSize, applicationName: 'cage-kernel' });
      const r = connect(opts.urls.read, { max: opts.poolSize, applicationName: 'cage-read' });
      this.handles.push(a, r);
      this.app = a.db;
      this.readDb = r.db;
    } else {
      throw new Error('[CAGE-ENV-001] createKernel 需要 urls 或 db');
    }
    this.read = new ReadSide(this);
  }

  async close(): Promise<void> {
    for (const h of this.handles) await h.close();
  }

  resolve(ref: string | AnyCommand): RegisteredCommand {
    const rc = this.registry.command(ref);
    if (!rc) {
      throw new Error(`[CAGE-REG-001] 找不到命令 ${typeof ref === 'string' ? ref : ref.agg.name + '.?'}，它是否从 domain 导出了？`);
    }
    return rc;
  }

  // ---------------- 写入 ----------------

  /** 执行一个命令（自己开事务）。返回按当前主体掩码后的新快照。 */
  async execute(ref: string | AnyCommand, raw: unknown, ctx: Ctx): Promise<Record<string, any>> {
    const rc = this.resolve(ref);
    try {
      return await step(`execute ${rc.capability}`, () =>
        this.app.transaction().execute(async (tx) => {
          const r = await this.run(tx, rc, raw, ctx, 0);
          return r.replay !== undefined ? (r.replay as Record<string, any>) : r.presented!;
        }),
      );
    } catch (e) {
      const ce = toCageError(e);
      if (ce.code === 'INTERNAL') this.log.error({ err: e, capability: rc.capability, requestId: ctx.requestId }, '命令执行异常');
      if (ce.code === 'FORBIDDEN' || ce.code === 'NOT_FOUND' || ce.code === 'CONSTRAINT_VIOLATED') {
        void this.auditDenied(rc, raw, ctx, ce);
      }
      throw ce;
    }
  }

  /** 在已有事务里执行（同事务反应、审批桥接、批量整批原子模式用）。返回未掩码的快照。 */
  async executeIn(tx: Transaction<any>, ref: string | AnyCommand, raw: unknown, ctx: Ctx, depth = 1): Promise<Record<string, any>> {
    const rc = this.resolve(ref);
    const r = await this.run(tx, rc, raw, ctx, depth);
    return (r.next ?? r.replay) as Record<string, any>;
  }

  /** 批量写入：每一行都完整走 12 关；默认逐行独立提交，可选整批原子。批量没有快捷路径。 */
  async executeBatch(ref: string | AnyCommand, rows: unknown[], ctx: Ctx, opts: { atomic?: boolean } = {}): Promise<BatchResult[]> {
    const rc = this.resolve(ref);
    const bctx: Ctx = { ...ctx, source: ctx.source === 'api' ? 'import' : ctx.source, idempotencyKey: undefined };
    if (!opts.atomic) {
      const out: BatchResult[] = [];
      for (let i = 0; i < rows.length; i++) {
        try {
          out.push({ index: i, ok: true, data: await this.execute(rc.cmd, rows[i], bctx) });
        } catch (e) {
          out.push({ index: i, ok: false, error: toCageError(e).toJSON() });
        }
      }
      return out;
    }
    let failedAt = -1;
    let failure: CageError | null = null;
    const results: BatchResult[] = [];
    try {
      await this.app.transaction().execute(async (tx) => {
        for (let i = 0; i < rows.length; i++) {
          try {
            const r = await this.run(tx, rc, rows[i], bctx, 0);
            results.push({ index: i, ok: true, data: r.presented });
          } catch (e) {
            failedAt = i;
            failure = toCageError(e);
            throw e;
          }
        }
      });
      return results;
    } catch {
      return rows.map((_, i) => ({
        index: i,
        ok: false,
        error: i === failedAt && failure ? (failure as CageError).toJSON() : { code: 'ABORTED', detail: '整批原子模式：其他行失败，本行已回滚' },
      }));
    }
  }

  private async run(
    tx: Transaction<any>,
    rc: RegisteredCommand,
    raw: unknown,
    ctx: Ctx,
    depth: number,
  ): Promise<{ next?: Record<string, any>; presented?: Record<string, any>; replay?: unknown }> {
    const { cmd, capability } = rc;
    const agg = cmd.agg;
    if (depth > this.maxDepth) throw new Error(`[CAGE-REACT-002] 同事务反应嵌套超过 ${this.maxDepth} 层`);

    // 第 1 关：认证
    if (!ctx.actor || (ctx.actor.kind === 'anonymous' && !cmd.public)) throw cageError('UNAUTHENTICATED');

    // 第 2 关：校验输入
    const { expectedVersion, rest } = splitRaw(raw);
    const parsed = cmd.input.safeParse(rest);
    if (!parsed.success) throw cageError('INVALID_INPUT', zodIssues(parsed.error));
    const input = parsed.data as Record<string, any>;

    // 第 3 关：调用方与能力
    assertInvoker(cmd, ctx, capability);
    if (!cmd.public && !ctx.capabilities.has(capability)) throw cageError('FORBIDDEN', { capability });

    // 幂等：先抢占幂等键（键按主体和能力点隔离）
    const idemKey = depth === 0 && ctx.idempotencyKey ? `${ctx.actor.id}:${capability}:${ctx.idempotencyKey}` : undefined;
    const claim = await idempotency.claim(tx, idemKey);
    if (!claim.fresh) return { replay: claim.result };

    await setSessionVars(tx, ctx);
    const now = new Date();
    const actorUserId = ctx.onBehalfOf ?? ctx.userId ?? null;
    const isNew = cmd.from === 'new';
    const fieldKeys = Object.keys(agg.fields as Fields);
    let cur: Record<string, any>;

    if (isNew) {
      // 新建：跳过第 4、5 关，由内核生成 id 和初始版本号；输入里的同名字段预填进草稿
      // 输入里带了 id（确定性主键，例如库存锁用采购单 id）时使用它，重复时报 CONFLICT
      const givenId = typeof input.id === 'string' ? input.id : undefined;
      cur = { id: givenId ?? randomUUID(), status: cmd.to, version: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      for (const k of fieldKeys) cur[k] = k in input ? input[k] : null;
      if (agg.scope.deptField && agg.scope.deptField !== 'id' && cur[agg.scope.deptField] == null) cur[agg.scope.deptField] = ctx.deptId;
    } else {
      if (typeof input.id !== 'string') throw cageError('INVALID_INPUT', [{ path: 'id', message: '缺少 id' }]);
      // 第 4 关：按范围加载并加行锁；范围外和不存在一律 404
      const loaded = await step('loadScoped', () => loadScoped(tx, agg, input.id, ctx, true));
      if (!loaded) throw cageError('NOT_FOUND');
      cur = loaded;
      // 第 5 关：状态守卫
      if (!(cmd.from as readonly string[]).includes(cur.status)) {
        throw cageError('INVALID_TRANSITION', { status: cur.status, allowed: cmd.from });
      }
      if (expectedVersion !== undefined && expectedVersion !== cur.version) throw cageError('CONFLICT', { expected: expectedVersion, actual: cur.version });
    }

    // 第 6 关：硬约束
    const meta: ConstraintMeta = {
      capability,
      capabilitiesOf: (uid) => this.capabilitiesOf(uid, ctx.tenantId),
      load: async (aggName, id) => {
        const a = this.registry.aggregate(aggName);
        return a && /^[0-9a-f-]{36}$/i.test(id) ? loadScoped(tx, a, id, ctx, false) : null;
      },
      catalog: () => this.catalogCaps(),
    };
    for (const c of cmd.constraints) {
      const r = await c.check(cur, ctx, input, meta);
      if (!r.ok) throw new CageError('CONSTRAINT_VIOLATED', { constraint: c.name, message: r.message });
    }

    // 第 7 关：只注入 reads 里声明的只读仓储
    const deps = bindReads(tx, cmd.reads, ctx);

    // 第 8 关：调用 handler（AI 写的代码）
    const draft = structuredClone(cur);
    const result = await step('handler', async () => cmd.handler(draft as any, input as any, deps as any, Object.freeze({ now, actorUserId })));
    if (isDomainError(result)) throw new CageError('DOMAIN_ERROR', result.detail, result.code);
    const changes: Record<string, any> = { ...draft, ...(result && typeof result === 'object' ? result : {}) };

    // 第 9 关：状态只由内核推进；创建人字段只由内核设置
    const next: Record<string, any> = { ...cur };
    for (const k of fieldKeys) if (k in changes) next[k] = changes[k] === undefined ? null : changes[k];
    const owner = agg.scope.ownerField;
    if (owner) next[owner] = isNew ? actorUserId ?? changes[owner] ?? null : cur[owner];
    // 保持状态的命令使用第 4 关加锁读出的状态，而不是 handler 返回值。
    // 因此晚到的第三方回执可以更新字段，但不能把已取消的单据重新推进到已审批。
    next.status = cmd.to ?? cur.status;
    const record = Object.fromEntries(fieldKeys.map((k) => [k, next[k] ?? ((agg.fields as Fields)[k].isOptional ? null : undefined)]));
    const valid = agg.schema.safeParse(record);
    if (!valid.success) throw cageError('INVALID_INPUT', zodIssues(valid.error));

    // 第 10 关：不变量
    for (const [name, fn] of Object.entries(agg.invariants)) {
      let holds = false;
      try {
        holds = !!fn(next as any);
      } catch {
        holds = false;
      }
      if (!holds) throw cageError('INVARIANT_VIOLATED', { invariant: `${agg.name}.${name}` });
    }

    // 第 11 关：带版本号写入 + 审计 + outbox + 同事务反应，全部在一个事务里
    const table = `${agg.table.schema}.${agg.table.name}`;
    if (isNew) {
      await tx
        .insertInto(table)
        .values({ id: next.id, tenant_id: ctx.tenantId, ...fieldsToColumns(agg, record), status: next.status, version: 1, created_at: now, updated_at: now })
        .execute();
      next.version = 1;
      // 新建的数据也必须在自己的范围内（不能替别的部门建单）
      const visible = await loadScoped(tx, agg, next.id, ctx, false);
      if (!visible) throw new CageError('CONSTRAINT_VIOLATED', { constraint: 'scope', message: '新建的数据不在你的数据范围内' });
    } else {
      const changed = diffFields(agg, cur, next);
      const res = await tx
        .updateTable(table)
        .set({ ...fieldsToColumns(agg, Object.fromEntries(changed.map((k) => [k, next[k]]))), status: next.status, version: cur.version + 1, updated_at: now })
        .where('id', '=', cur.id)
        .where('version', '=', cur.version)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw cageError('CONFLICT');
      next.version = cur.version + 1;
    }
    next.updatedAt = now.toISOString();

    const changed = isNew ? fieldKeys.filter((k) => next[k] !== null) : diffFields(agg, cur, next);
    await this.writeAudit(tx, {
      tenantId: ctx.tenantId,
      actor: ctx.actor.id,
      actorKind: ctx.actor.kind,
      onBehalfOf: ctx.onBehalfOf ?? null,
      source: ctx.source,
      kind: 'write',
      capability,
      command: capability,
      aggregate: agg.name,
      aggregateId: next.id,
      result: 'ok',
      diff: auditDiff(agg, isNew ? null : cur, next, changed),
      requestId: ctx.requestId ?? null,
      idempotencyKey: ctx.idempotencyKey ?? null,
      client: ctx.client ?? null,
    });

    const events = await this.enqueueEvents(tx, cmd, next, input, ctx, isNew ? null : cur);
    for (const ev of events) {
      for (const { r, name } of this.registry.reactionsFor(ev.event)) {
        if (r.tx !== 'same') continue;
        const rin = r.map(ev.payload as any);
        if (rin === null || rin === undefined) continue;
        const rctx = systemCtx({
          kind: 'reaction', name, tenantId: ctx.tenantId, capabilities: [this.registry.capabilityOf(r.command)],
          onBehalfOf: actorUserId, requestId: ctx.requestId,
        });
        await this.run(tx, this.resolve(r.command), rin, rctx, depth + 1);
      }
    }

    if (agg.options.grants) {
      // 授权变化：事务提交后通知所有实例清掉上下文缓存（回滚就不会发）
      const payload = agg.options.grants === 'self' ? String(next.id) : '*';
      await sql`select pg_notify('cage_grants', ${payload})`.execute(tx);
    }

    const presented = present(agg, next, ctx);
    await idempotency.complete(tx, idemKey, presented);
    // 第 12 关：函数返回即提交事务；随后由 outbox 投递器异步分发事件
    return { next, presented };
  }

  private async enqueueEvents(tx: Transaction<any>, cmd: AnyCommand, next: Record<string, any>, input: Record<string, any>, ctx: Ctx, prev: Record<string, any> | null): Promise<EmittedEvent[]> {
    const out: EmittedEvent[] = [];
    if (cmd.emits.length === 0) return out;
    const carrier = traceCarrier();
    for (const spec of cmd.emits) {
      const ev = spec.event;
      const rawPayload = spec.map ? spec.map(next, input, prev) : defaultPayload(ev, next, input);
      const p = ev.schema.safeParse(rawPayload);
      if (!p.success) {
        throw new Error(`[CAGE-EVENT-001] 事件 ${ev.name} 的载荷不符合声明：${JSON.stringify(zodIssues(p.error))}`);
      }
      const payload = maskEventPayload(ev, p.data as Record<string, unknown>);
      const row = await tx
        .insertInto('sys.outbox')
        .values({
          tenant_id: ctx.tenantId,
          event: ev.name,
          aggregate: cmd.agg.name,
          aggregate_id: next.id,
          payload: JSON.stringify(payload),
          actor: JSON.stringify({ kind: ctx.actor?.kind, id: ctx.actor?.id, userId: ctx.userId, onBehalfOf: ctx.onBehalfOf ?? null }),
          trace: JSON.stringify(carrier),
          request_id: ctx.requestId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      out.push({ outboxId: Number(row.id), event: ev.name, payload });
    }
    await sql`select pg_notify('cage_outbox', '')`.execute(tx);
    return out;
  }

  // ---------------- 审计 ----------------

  async writeAudit(db: Transaction<any> | Kysely<any>, e: AuditEntry): Promise<void> {
    await db
      .insertInto('sys.audit_log')
      .values({
        tenant_id: e.tenantId,
        actor: e.actor,
        actor_kind: e.actorKind,
        on_behalf_of: e.onBehalfOf ?? null,
        source: e.source,
        kind: e.kind,
        capability: e.capability ?? null,
        command: e.command ?? null,
        aggregate: e.aggregate ?? null,
        aggregate_id: e.aggregateId ?? null,
        result: e.result,
        diff: e.diff === undefined || e.diff === null ? null : JSON.stringify(e.diff),
        request_id: e.requestId ?? null,
        idempotency_key: e.idempotencyKey ?? null,
        client: e.client ? JSON.stringify(e.client) : null,
      })
      .execute();
  }

  /** 被拒绝的尝试异步记录，用于发现探测和配置问题；记录失败不影响请求 */
  async auditDenied(rc: RegisteredCommand, raw: unknown, ctx: Ctx, err: CageError): Promise<void> {
    try {
      const id = (raw as any)?.id;
      await this.writeAudit(this.app, {
        tenantId: ctx.tenantId,
        actor: ctx.actor?.id ?? 'anonymous',
        actorKind: ctx.actor?.kind ?? 'anonymous',
        onBehalfOf: ctx.onBehalfOf ?? null,
        source: ctx.source,
        kind: 'denied',
        capability: rc.capability,
        command: rc.capability,
        aggregate: rc.cmd.agg.name,
        aggregateId: typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null,
        result: err.code,
        diff: err.detail && typeof err.detail === 'object' ? { detail: err.detail } : null,
        requestId: ctx.requestId ?? null,
        client: ctx.client ?? null,
      });
    } catch (e) {
      this.log.warn({ err: String(e) }, '拒绝审计写入失败');
    }
  }

  // ---------------- 上下文 ----------------

  private catalogCache?: string[];
  catalogCaps(): string[] {
    return (this.catalogCache ??= this.registry.capabilityCatalog().map((c) => c.capability));
  }

  async capabilitiesOf(userId: string, tenantId: string): Promise<Map<string, CapabilityParams>> {
    const g = await loadUserGrants(this.app, userId, tenantId);
    return g && g.active ? g.capabilities : new Map();
  }

  /** 把一个用户解析成上下文（HTTP 层会加缓存） */
  async contextFor(userId: string, tenantId: string, extra: Partial<Ctx> = {}): Promise<Ctx | null> {
    const g = await loadUserGrants(this.app, userId, tenantId);
    return g ? userCtx(g, extra) : null;
  }

  /** 审批流程身份：代表最后一位审批人调用结论命令 */
  processCtx(opts: { process: string; tenantId: string; onBehalfOf: string; capabilities: string[]; requestId?: string }): Ctx {
    return systemCtx({ kind: 'process', name: opts.process, tenantId: opts.tenantId, capabilities: opts.capabilities, onBehalfOf: opts.onBehalfOf, requestId: opts.requestId });
  }
}

export function createKernel(opts: KernelOptions): Kernel {
  return new Kernel(opts);
}

function splitRaw(raw: unknown): { expectedVersion?: number; rest: unknown } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rest: raw ?? {} };
  const { expectedVersion, ...rest } = raw as Record<string, unknown>;
  if (expectedVersion === undefined || expectedVersion === null) return { rest };
  const v = Number(expectedVersion);
  if (!Number.isInteger(v)) throw cageError('INVALID_INPUT', [{ path: 'expectedVersion', message: '版本号必须是整数' }]);
  return { expectedVersion: v, rest };
}

/** 第 3 关之一：流程专用命令只接受流程身份；用户命令可以被声明过它的系统身份调用 */
function assertInvoker(cmd: AnyCommand, ctx: Ctx, capability: string): void {
  const kind = ctx.actor!.kind;
  if (kind === 'system') return;
  if (kind === 'user' || kind === 'anonymous') {
    if (!cmd.invokedBy.includes('user')) {
      throw cageError('FORBIDDEN', { capability, message: `该命令只接受 ${cmd.invokedBy.join('/')} 调用` });
    }
    return;
  }
  const as = kind === 'reaction' ? 'process' : kind;
  if (!cmd.invokedBy.includes('user') && !cmd.invokedBy.includes(as as any)) {
    throw cageError('FORBIDDEN', { capability, message: `${kind} 身份不能调用该命令` });
  }
}

function maskEventPayload(ev: AnyEvent, payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const [k, f] of Object.entries(ev.fields as Fields)) {
    if (f.sensitiveKind && k in out) out[k] = maskValue(f.sensitiveKind, out[k]);
    if (f.isHidden) delete out[k];
  }
  return out;
}

export type { AnyAggregate };
