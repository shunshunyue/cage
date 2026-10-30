// /api/sys/*：系统管理接口。组织与授权的写操作直接用生成的命令路由（/api/role/:id/grant-capability 等），
// 这里只放内核系统表的查询与运维动作；每个接口都要求对应的系统能力点，运维动作写审计。
import { cageError, sensitiveFields, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { discardDeadLetter, nextRun, replayDeadLetter } from '@yss123/cage-kernel/worker';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

const ctxOf = (req: any): Ctx => req.cageCtx as Ctx;

function need(ctx: Ctx, cap: string) {
  if (!ctx.userId) throw cageError('UNAUTHENTICATED');
  if (!ctx.capabilities.has(cap)) throw cageError('FORBIDDEN', { capability: cap });
}

const intParam = (v: unknown, d: number, max: number) => Math.min(max, Math.max(1, Number(v ?? d) || d));

export function adminRoutes(app: FastifyInstance, k: Kernel) {
  const opsAudit = (ctx: Ctx, command: string, detail: unknown) =>
    k.writeAudit(k.app, {
      tenantId: ctx.tenantId, actor: ctx.actor!.id, actorKind: ctx.actor!.kind, source: 'api', kind: 'ops',
      capability: 'Sys.ops.manage', command, result: 'ok', diff: detail, requestId: ctx.requestId ?? null, client: ctx.client ?? null,
    });

  app.get('/api/sys/catalog', async (req) => {
    const ctx = ctxOf(req);
    if (!ctx.userId) throw cageError('UNAUTHENTICATED');
    return {
      capabilities: k.registry.capabilityCatalog(),
      aggregates: k.registry.aggregates.map((a) => ({
        name: a.name, description: a.description ?? null, states: a.states.values,
        scope: { deptField: a.scope.deptField ?? null, ownerField: a.scope.ownerField ?? null },
        sensitive: sensitiveFields(a),
      })),
      combinators: ['self', 'dept', 'deptSubtree', 'deptSet', 'all'],
      approvals: k.registry.approvals.map(({ a, name }) => ({ name, process: a.process, aggregate: a.agg.name, routable: a.routable })),
      jobs: k.registry.jobs.map((j) => ({ name: j.name, cron: j.cron, description: j.description ?? null })),
    };
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
