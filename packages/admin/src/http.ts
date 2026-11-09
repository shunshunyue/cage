/**
 * 系统管理 HTTP 装配层，组合目录、审计、异步运维与第三方同步查询。
 * 组织业务写操作由声明生成的命令路由承接；这里仅提供系统查询和受控运维动作。
 * 请求上下文来自上游认证，读取与管理能力分开检查，任务受理和异步完成不能混为一谈。
 */
// /api/sys/*：系统管理接口。组织与授权的写操作直接用生成的命令路由（/api/role/:id/grant-capability 等），
// 这里只放内核系统表的查询与运维动作；每个接口都要求对应的系统能力点，运维动作写审计。
import { cageError, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { adminCatalog, type AdminLabels } from './catalog.js';
import { discardDeadLetter, nextRun, replayDeadLetter } from '@yss123/cage-kernel/worker';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { diagnosticRoutes } from './diagnostics.js';

/**
 * 读取上游认证钩子已装配的可信上下文；本辅助函数本身不解析 Cookie 或验证身份。
 */
const ctxOf = (req: any): Ctx => req.cageCtx as Ctx;

/**
 * 在每个系统入口检查登录及指定能力，失败立即抛出标准 Cage 错误。
 * 这层能力检查不能替代具体查询中的租户条件或安全读侧范围过滤。
 */
function need(ctx: Ctx, cap: string) {
  if (!ctx.userId) throw cageError('UNAUTHENTICATED');
  if (!ctx.capabilities.has(cap)) throw cageError('FORBIDDEN', { capability: cap });
}

/**
 * 为管理列表把数字输入限制在 1 至 max 的区间，缺值或不能转为有效数字时采用默认值 d。
 * 沿用 Number 转换行为；这里没有额外承诺严格整数格式校验。
 */
const intParam = (v: unknown, d: number, max: number) => Math.min(max, Math.max(1, Number(v ?? d) || d));

/**
 * 在 Fastify 实例注册管理接口，同时接入只读 diagnosticRoutes。
 * 审计从安全视图读取；outbox、死信和连接器记录按当前租户查询，列表有固定上限。
 * 死信重放/丢弃与任务开关要求 Sys.ops.manage，并在操作后记录审计；重放只重新排队，不表示执行成功。
 * 任务开关以注册任务名管理调度状态；本函数不授予领域能力，也不替调用方初始化组织。
 */
export function adminRoutes(app: FastifyInstance, k: Kernel, labels: AdminLabels = {}) {
  diagnosticRoutes(app, k);
  const opsAudit = (ctx: Ctx, command: string, detail: unknown) =>
    k.writeAudit(k.app, {
      tenantId: ctx.tenantId, actor: ctx.actor!.id, actorKind: ctx.actor!.kind, source: 'api', kind: 'ops',
      capability: 'Sys.ops.manage', command, result: 'ok', diff: detail, requestId: ctx.requestId ?? null, client: ctx.client ?? null,
    });

  app.get('/api/sys/catalog', async (req) => {
    const ctx = ctxOf(req);
    if (!ctx.userId) throw cageError('UNAUTHENTICATED');
    return adminCatalog(k.registry, labels);
  });

  // ---------- 审计查询：读侧账号 + safe.audit_log 视图（内核账号本身读不到审计） ----------
  app.get('/api/sys/audit', async (req) => {
    const ctx = ctxOf(req);
    need(ctx, 'Sys.audit.read');
    const q = req.query as Record<string, string | undefined>;
    const page = intParam(q.page, 1, 100000);
    const pageSize = intParam(q.pageSize, 50, 200);
    return k.read.tx(ctx, async (tx) => {
      let b = tx.selectFrom('safe.audit_log').selectAll();
      if (q.actor) b = b.where('actor', '=', q.actor);
      if (q.aggregate) b = b.where('aggregate', '=', q.aggregate);
      if (q.aggregateId && /^[0-9a-f-]{36}$/i.test(q.aggregateId)) b = b.where('aggregate_id', '=', q.aggregateId);
      if (q.command) b = b.where('command', '=', q.command);
      if (q.kind) b = b.where('kind', '=', q.kind);
      if (q.result) b = b.where('result', '=', q.result);
      if (q.from) b = b.where('at', '>=', new Date(q.from));
      if (q.to) b = b.where('at', '<', new Date(q.to));
      const rows = await b.orderBy('at', 'desc').orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute();
      return { items: rows, page, pageSize };
    });
  });

  // ---------- 异步任务 ----------
  app.get('/api/sys/ops/summary', async (req) => {
    const ctx = ctxOf(req);
    need(ctx, 'Sys.ops.read');
    const outbox = await k.app.selectFrom('sys.outbox').select(['status', sql<number>`count(*)::int`.as('n'), sql<string>`min(created_at)`.as('oldest')])
      .where('tenant_id', '=', ctx.tenantId).where('status', '<>', 'done').groupBy('status').execute();
    const dead = await k.app.selectFrom('sys.dead_letter').select(sql<number>`count(*)::int`.as('n'))
      .where('tenant_id', '=', ctx.tenantId).where('handled_at', 'is', null).executeTakeFirst();
    const sync = await k.app.selectFrom('sys.sync_record').select(['connector', 'status', sql<number>`count(*)::int`.as('n')])
      .where('tenant_id', '=', ctx.tenantId).groupBy(['connector', 'status']).execute();
    return { outbox, deadLetters: dead?.n ?? 0, sync };
  });

  app.get('/api/sys/ops/outbox', async (req) => {
    const ctx = ctxOf(req);
    need(ctx, 'Sys.ops.read');
    const q = req.query as Record<string, string | undefined>;
    return k.app.selectFrom('sys.outbox').select(['id', 'event', 'aggregate', 'aggregate_id', 'status', 'attempts', 'last_error', 'next_at', 'created_at'])
      .where('tenant_id', '=', ctx.tenantId).where('status', '=', q.status ?? 'pending').orderBy('id', 'desc').limit(200).execute();
  });

  app.get('/api/sys/ops/dead-letters', async (req) => {
    const ctx = ctxOf(req);
    need(ctx, 'Sys.ops.read');
    const handled = (req.query as any)?.handled === 'true';
    let b = k.app.selectFrom('sys.dead_letter').selectAll().where('tenant_id', '=', ctx.tenantId);
    b = handled ? b.where('handled_at', 'is not', null) : b.where('handled_at', 'is', null);
    return b.orderBy('id', 'desc').limit(200).execute();
  });

  for (const action of ['replay', 'discard'] as const) {
    app.post(`/api/sys/ops/dead-letters/:id/${action}`, async (req) => {
      const ctx = ctxOf(req);
      need(ctx, 'Sys.ops.manage');
      const id = Number((req.params as any).id);
      if (!Number.isInteger(id)) throw cageError('NOT_FOUND');
      const own = await k.app.selectFrom('sys.dead_letter').select('id').where('id', '=', id).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!own) throw cageError('NOT_FOUND');
      try {
        await (action === 'replay' ? replayDeadLetter : discardDeadLetter)(k, id, ctx.actor!.id);
      } catch (e) {
        throw cageError('INVALID_TRANSITION', String((e as Error).message));
      }
      await opsAudit(ctx, `deadLetter.${action}`, { deadLetterId: id });
      return { ok: true };
    });
  }

  app.get('/api/sys/ops/jobs', async (req) => {
    const ctx = ctxOf(req);
    need(ctx, 'Sys.ops.read');
    const states = await k.app.selectFrom('sys.job_state').selectAll().execute();
    const byName = new Map(states.map((s) => [s.name, s]));
    return k.registry.jobs.map((j) => {
      const s = byName.get(j.name);
      let next: string | null = null;
      try {
        next = nextRun(j.cron, new Date()).toISOString();
      } catch {
        next = null;
      }
      return {
        name: j.name, cron: j.cron, description: j.description ?? null, enabled: s?.enabled ?? true,
        lastRunAt: s?.last_run_at ?? null, lastStatus: s?.last_status ?? null, lastError: s?.last_error ?? null, nextRunAt: next,
        reads: j.reads.map((a) => a.name), calls: j.calls.map((c) => k.registry.capabilityOf(c)),
      };
    });
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/api/sys/ops/jobs/:name/${action}`, async (req) => {
      const ctx = ctxOf(req);
      need(ctx, 'Sys.ops.manage');
      const name = String((req.params as any).name);
      if (!k.registry.jobs.some((j) => j.name === name)) throw cageError('NOT_FOUND');
      await k.app.insertInto('sys.job_state').values({ name, enabled: action === 'enable' })
        .onConflict((oc) => oc.column('name').doUpdateSet({ enabled: action === 'enable', updated_at: sql`now()` })).execute();
      await opsAudit(ctx, `job.${action}`, { job: name });
      return { ok: true };
    });
  }

  // ---------- 第三方同步 ----------
  app.get('/api/sys/ops/sync-records', async (req) => {
    const ctx = ctxOf(req);
    need(ctx, 'Sys.ops.read');
    const q = req.query as Record<string, string | undefined>;
    let b = k.app.selectFrom('sys.sync_record').select(['id', 'connector', 'operation', 'ref_id', 'status', 'http_status', 'attempts', 'error', 'created_at', 'updated_at'])
      .where('tenant_id', '=', ctx.tenantId);
    if (q.connector) b = b.where('connector', '=', q.connector);
    if (q.status) b = b.where('status', '=', q.status);
    return b.orderBy('id', 'desc').limit(200).execute();
  });
}
