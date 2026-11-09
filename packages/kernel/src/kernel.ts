// 内核：唯一的写入入口 execute。HTTP、审批流程、定时任务、反应、批量导入都调用它，
// 所以检查只写一遍，顺序永远一样（设计文档第 5 节的 12 关）。
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
import { reactionEntries, reactionEntryError } from './primitives/collection.js';
import type { Fields } from './primitives/fields.js';
import { ReadSide } from './read.js';
import { buildRegistry, type RegisteredCommand, type Registry, type RegistryOptions } from './registry.js';
import { consoleLogger, type Logger, step, traceCarrier } from './telemetry.js';
import type { CapabilityParams, Ctx } from './types.js';
import { DataTransfers } from './transfer/index.js';
import { writeRelations } from './relations.js';
import { assertInvoker } from './pipeline/invoker.js';
import { explainAuthorization } from './authorization.js';
import { newDraft, splitRaw } from './pipeline/draft.js';
import { writeFileLinks } from './files/links.js';

/** 内核实例配置；传 db 时连接归宿主所有，传 urls 时内核自行创建并在 close 时销毁池。 */
export interface KernelOptions {
  /** domain 包的导出（可以是多个模块，例如框架自带的组织模型 + 业务声明） */
  domain: object | object[];
  /** 数据库连接串；或者直接传入已有的连接 */
  urls?: DatabaseUrls;
  /** 宿主注入的写库与只读库句柄；提供后优先于 urls，close 不销毁这些外部连接。 */
  db?: { app: Kysely<any>; read: Kysely<any> };
  /** 注册表的额外能力等选项；不用于运行期动态改变角色授权。 */
  registryOptions?: RegistryOptions;
  /** 结构化日志实现；省略时使用默认 consoleLogger，调用方仍不能在元数据中塞入敏感业务原文。 */
  logger?: Logger;
  /** 同事务反应的最大嵌套深度 */
  maxReactionDepth?: number;
  /** 连接池大小 */
  poolSize?: number;
}

/** 当前事务已登记的事件，含 outbox ID；事务尚未提交时不可将其视为外部已收到的事实。 */
export interface EmittedEvent {
  /** 同事务写入的 outbox 数字 ID，用于关联投递记录；不是业务对象 ID。 */
  outboxId: number;
  /** 已注册的事件名称，决定匹配哪些消费者。 */
  event: string;
  /** 通过事件 schema 校验的业务载荷，仅供内部消费者使用，不可直接作为公共诊断响应。 */
  payload: Record<string, unknown>;
}

/** index 为输入行的 0 基索引；atomic 模式任一失败会把其余行标为已回滚，不能交付暂存成功结果。 */
export interface BatchResult {
  /** 输入 rows 中从零开始的位置，调用方据此对应原始导入行。 */
  index: number;
  /** 该行最终是否成功提交；整批原子失败时此前暂存成功也会被改为失败。 */
  ok: boolean;
  /** 成功时可交付的记录快照，已按主体权限处理敏感字段；失败时省略。 */
  data?: Record<string, unknown>;
  /** 失败时的框架错误码、可选领域码和详情；不包含成功数据。 */
  error?: { code: string; domainCode?: string; detail?: unknown };
}

/** 审计写入规格；diff/client 必须由可信调用方脱敏，writeAudit 不推断业务字段的敏感政策。 */
export interface AuditEntry {
  /** 审计所属租户，必须来自可信执行上下文。 */
  tenantId: string;
  /** 实际执行主体标识，可能是真人用户 ID 或流程/任务身份名。 */
  actor: string;
  /** 执行主体种类，与 actor 共同解释身份；不能仅凭字符串把系统主体当作真人。 */
  actorKind: string;
  /** 系统执行代表的真人 ID；没有委托时省略或 null。 */
  onBehalfOf?: string | null;
  /** 触发入口来源，如 api、process、job、external；用于追踪，不授予权限。 */
  source: string;
  /** write 业务写审计、read 读取审计、denied 拒绝记录、ops 运维动作。 */
  kind: 'write' | 'read' | 'denied' | 'ops';
  /** 本次操作关联的能力名；无单一能力时可空。 */
  capability?: string | null;
  /** 关联的完整命令名；读取或普通运维事件可空。 */
  command?: string | null;
  /** 关联聚合名；无具体业务对象时可空。 */
  aggregate?: string | null;
  /** 单一关联记录 ID；多记录读取或无对象时可空。 */
  aggregateId?: string | null;
  /** 执行结论或机器错误码，由调用者按实际提交/拒绝结果填写。 */
  result: string;
  /** 经调用方脱敏的变化或操作摘要；writeAudit 不替调用方恢复字段策略。 */
  diff?: unknown;
  /** 跨 HTTP、命令和异步事件关联的追踪标识；省略或 null 表示未提供。 */
  requestId?: string | null;
  /** 本次逻辑提交的去重键，仅记录审计关联，不在本方法执行去重。 */
  idempotencyKey?: string | null;
  /** 调用方允许记录的客户端摘要，例如 IP/UA；不得包含 Cookie、密码或完整请求体。 */
  client?: unknown;
}

function zodIssues(e: z.ZodError) {
  return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/**
 * 领域写入的统一执行器。权限、版本、状态、约束、不变量、关联、审计和事件在此汇合，
 * 业务 handler 仅计算字段变化，不能越过这些阶段。读服务使用独立账号，worker 复用注册规格。
 * 实例关闭只释放自身创建的池；运行时扩展和 worker 的生命周期由其装配方先行停止。
 */
export class Kernel {
  /** 解释能力、范围、状态及约束的当前证据，不执行 handler 或提交业务写入；结果不是未来执行一定成功的承诺。 */
  explain(capability: string, input: Record<string, unknown>, ctx: Ctx) { return explainAuthorization(this, capability, input, ctx); }
  /** 由 domain 导出建立的运行规格，供命令解析、读侧、DDL 和 worker 共享。 */
  readonly registry: Registry;
  /** 内部写账号连接；业务应用应走命令，不能据此绕过流水线直接写表。 */
  readonly app: Kysely<any>;
  /** 只读账号连接，用于 safe 视图事务；不能用写账号代替以省略数据库权限隔离。 */
  readonly readDb: Kysely<any>;
  /** 按当前 Ctx 授权、范围与掩码读取的公共读服务。 */
  readonly read: ReadSide;
  /** 后台导入导出协调器，任务状态和结果文件不等同于单次同步读写返回。 */
  readonly transfers: DataTransfers;
  /** 实例日志出口，用于安全元数据与机器码，不传未经处理的敏感业务数据。 */
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
    this.transfers = new DataTransfers(this);
  }

  /** 释放由本实例创建的数据库句柄；外部注入 db 不在 handles 中，不会被擅自销毁。 */
  async close(): Promise<void> {
    for (const h of this.handles) await h.close();
  }

  /** 按能力字符串或声明对象解析命令；未从 domain 导出时明确报错，不动态注册陌生命令。 */
  resolve(ref: string | AnyCommand): RegisteredCommand {
    const rc = this.registry.command(ref);
    if (!rc) {
      throw new Error(`[CAGE-REG-001] 找不到命令 ${typeof ref === 'string' ? ref : ref.agg.name + '.?'}，它是否从 domain 导出了？`);
    }
    return rc;
  }

  // ---------------- 写入 ----------------

  /** 执行一个命令（自己开事务）。返回按当前主体掩码后的新快照。 */
  /**
   * 事务拥有者：run 任一阶段失败都会回滚，最终返回掩码后的结果或已提交幂等回放。
   * 预期拒绝转换为统一错误；部分拒绝另做尽力审计，审计失败不改变原请求的拒绝结论。
   */
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
  /** 外层持有提交权；返回完整内部快照只供受信任框架流程使用，不可直接写入 HTTP 响应。 */
  async executeIn(tx: Transaction<any>, ref: string | AnyCommand, raw: unknown, ctx: Ctx, depth = 1): Promise<Record<string, any>> {
    const rc = this.resolve(ref);
    const r = await this.run(tx, rc, raw, ctx, depth);
    return (r.next ?? r.replay) as Record<string, any>;
  }

  /** 可选服务在同一事务登记执行回执时使用；只返回可交付字段，避免泄漏内部快照。 */
  async executePresentedIn(tx: Transaction<any>, ref: string | AnyCommand, raw: unknown, ctx: Ctx): Promise<Record<string, any>> {
    const rc = this.resolve(ref);
    const result = await this.run(tx, rc, raw, ctx, 0);
    return result.presented ?? present(rc.cmd.agg, result.replay as Record<string, any>, ctx);
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

  /**
   * 完整事务流水线：输入/身份→幂等→加锁加载→状态/版本→硬约束→受限 handler→合并/不变量→持久化。
   * 写记录、关系、附件、成功审计、outbox 和 same 反应共同提交；任何失败都必须传播到事务拥有者。
   * depth 限制同事务递归，只在最外层使用请求幂等键，避免不同反应错误共享同一回放结果。
   * next 是内部完整快照，presented 是可交付快照，replay 是已有请求结果，三者用途不可混淆。
   */
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
    const fields = agg.fields as Fields;
    const inverseKeys = Object.keys(fields).filter((key) => fields[key].kind === 'hasMany');
    // hasMany 的归属保存在子对象的 ref 上；拒绝写入，避免调用者误以为传入数组就会搬动子对象。
    if (rest && typeof rest === 'object' && inverseKeys.some((key) => Object.hasOwn(rest, key)))
      throw cageError('INVALID_INPUT', { message: 'hasMany 是只读反查，请通过子对象命令修改 mappedBy 指向的外键' });

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
    const fieldKeys = Object.keys(fields).filter((key) => fields[key].kind !== 'hasMany');
    let cur: Record<string, any>;

    if (isNew) {
      // 新建：跳过第 4、5 关，由内核生成 id 和初始版本号；输入里的同名字段预填进草稿
      // 输入里带了 id（确定性主键，例如库存锁用采购单 id）时使用它，重复时报 CONFLICT
      cur = newDraft(cmd, input, ctx, now);
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
      // 额度等约束复用当前写事务连接，避免同对象的并发等待者占满池后，锁持有者再借连接形成死锁。
      // 仍实时加载角色并检查账号 active；不缓存能力，也不改变约束看到的权限集合。
      capabilitiesOf: async (uid) => {
        const grants = await loadUserGrants(tx, uid, ctx.tenantId);
        return grants?.active ? grants.capabilities : new Map();
      },
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
    if (inverseKeys.some((key) => Object.hasOwn(changes, key)))
      throw cageError('INVALID_INPUT', { message: 'handler 不能给 hasMany 赋值；请调用子对象命令' });

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
    // 关系是无序集合；统一 UUID 大小写、去重并排序，让审计及重试只记录真正的关联变化。
    for (const k of fieldKeys) if (fields[k].kind === 'manyToMany')
      next[k] = [...new Set((next[k] as string[]).map((id) => id.toLowerCase()))].sort();
    for (const k of fieldKeys) if (fields[k].kind === 'file' || fields[k].kind === 'files') {
      next[k] = Array.isArray(next[k]) ? next[k].map((id: string) => id.toLowerCase()) : next[k]?.toLowerCase() ?? null;
      record[k] = next[k];
    }

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
    await writeRelations(tx, this.registry, agg, isNew ? {} : cur, next, ctx);
    await writeFileLinks(tx, agg, isNew ? {} : cur, next, ctx);

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
        const rctx = systemCtx({
          kind: 'reaction', name, tenantId: ctx.tenantId, capabilities: [this.registry.capabilityOf(r.command)],
          onBehalfOf: actorUserId, requestId: ctx.requestId,
        });
        for (const entry of reactionEntries(r, ev.payload)) {
          try {
            await this.run(tx, this.resolve(r.command), entry.input, rctx, depth + 1);
          } catch (error) {
            throw reactionEntryError(error, r, name, entry);
          }
        }
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

  /**
   * 在业务事务内映射并校验每个事件，遮盖敏感载荷后持久化提交版本、真人委托与追踪上下文。
   * 任一映射/schema 错误使整个命令回滚；NOTIFY 也随事务提交生效，不会唤醒 worker 消费未提交数据。
   */
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
          aggregate_version: next.version,
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

  /**
   * 只负责持久化审计，不吞异常。传事务时与业务共同提交；可靠读审计失败应阻止交付明文。
   * 拒绝审计等尽力路径由上层自行 catch，不能在此统一忽略错误而破坏成功写入的审计保证。
   */
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
  /** 当前实例注册表固定，故可缓存能力名称；角色实际授权仍需按用户从数据库读取。 */
  catalogCaps(): string[] {
    return (this.catalogCache ??= this.registry.capabilityCatalog().map((c) => c.capability));
  }

  /** 实时加载真人能力供额度约束使用；用户不存在或禁用时返回空集合。 */
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

/** 构造注册表、连接句柄及读/传输服务；不会自动迁移、初始化组织或启动 worker。 */
export function createKernel(opts: KernelOptions): Kernel {
  return new Kernel(opts);
}

/** 事件持久化不继承操作者明文权限：按事件字段声明掩码/删除，避免异步消费者获得多余秘密。 */
function maskEventPayload(ev: AnyEvent, payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const [k, f] of Object.entries(ev.fields as Fields)) {
    if (f.sensitiveKind && k in out) out[k] = maskValue(f.sensitiveKind, out[k]);
    if (f.isHidden) delete out[k];
  }
  return out;
}

export type { AnyAggregate };
