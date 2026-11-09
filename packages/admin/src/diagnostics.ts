/**
 * 提供当前进程、授权解释及异步执行时间线的只读诊断。
 * 接口要求登录和 Sys.ops.read；涉及具体对象时继续检查读取能力与数据范围。
 * 时间线只展示已存在的执行记录，不把静态关系当作成功证据；错误内容仅保留可检索代码。
 */
// 诊断只关联实际记录，不从静态图推断某一次操作已经执行；入口复用运维与安全读权限。
import { cageError, compileScope, loadScoped, registryFingerprint, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { workerSnapshot } from '@yss123/cage-kernel/worker';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const request = z.object({ requestId: z.string().min(1).max(200).optional(), outboxId: z.coerce.number().int().positive().optional(), aggregate: z.string().optional(), aggregateId: z.uuid().optional() });
const authorization = z.object({ command: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}), userId: z.uuid().optional() });
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * 检查诊断入口所需的登录身份与运维读取能力。
 * 未登录与已登录但无权分别抛 UNAUTHENTICATED / FORBIDDEN，不执行任何授权变更。
 */
function requireOps(ctx: Ctx) {
  if (!ctx.userId) throw cageError('UNAUTHENTICATED');
  if (!ctx.capabilities.has('Sys.ops.read')) throw cageError('FORBIDDEN');
}

/** 错误文本可能含请求载荷或第三方响应，诊断默认只交付可检索的机器码。 */
function failure(value: unknown): { code: string; detail: string } | null {
  if (value === null || value === undefined || value === '') return null;
  const code = typeof value === 'string' ? value.match(/\b(CAGE-[A-Z]+-\d{3}|UNAUTHENTICATED|FORBIDDEN|NOT_FOUND|INVALID_INPUT|CONFLICT|INTERNAL|RATE_LIMITED|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/)?.[1] : undefined;
  return { code: code ?? 'INTERNAL', detail: '原始错误文本已隐藏；请按错误码和关联记录排查' };
}

/**
 * 选取 worker 运行元数据用于诊断，缺记录返回 null。
 * lastError 经 failure 隐去原始文本，避免外部响应或业务载荷进入诊断页面。
 */
function workerDetails(raw: any) {
  if (!raw) return null;
  return { id: raw.id, pid: raw.pid, status: raw.status, listenerHealthy: raw.listenerHealthy, schedulerHealthy: raw.schedulerHealthy,
    heartbeatAt: raw.heartbeatAt, inFlight: raw.inFlight, lastError: failure(raw.lastError) };
}

/**
 * 将三个诊断接口注册到已有 Fastify 实例，复用认证层写入的 cageCtx。
 * 总览比较 API/worker 指纹与心跳；授权解释复用内核判断但不执行 handler；时间线按对象范围筛选后限量。
 * 解释其他用户身份还要求操作者能读取该用户。审计明细额外要求 Sys.audit.read。
 * 返回记录受数量上限限制，truncated 表示尚有未返回证据；本函数不迁移、不重启进程或恢复失败任务。
 */
export function diagnosticRoutes(app: FastifyInstance, k: Kernel) {
  const loadedAt = new Date().toISOString();
  app.get('/api/sys/diagnostics', async (req) => {
    const ctx = (req as any).cageCtx as Ctx;
    requireOps(ctx);
    const [workers, migrations, roles] = await Promise.all([
      k.app.selectFrom('sys.worker_runtime').selectAll().orderBy('heartbeat_at', 'desc').limit(10).execute(),
      k.app.selectFrom('sys.schema_migrations').select('name').execute(),
      k.app.selectFrom('sys.role').select('capabilities').where('tenant_id', '=', ctx.tenantId).where('status', '=', 'active').execute(),
    ]);
    const registryHash = registryFingerprint(k.registry);
    const worker = workers[0];
    const lastHeartbeatAt = worker ? new Date(worker.heartbeat_at).toISOString() : null;
    return {
      version, role: 'api', registryHash, loadedAt,
      consumers: worker?.manifest?.consumers,
      worker: worker ? { version: worker.manifest.version, registryHash: worker.registry_fingerprint, lastHeartbeatAt,
        ready: worker.status === 'running' && Date.now() - Date.parse(lastHeartbeatAt!) < 30_000 && worker.registry_fingerprint === registryHash,
        details: workerDetails(worker.details), manifest: worker.manifest } : undefined,
      authorization: { configuredCapabilities: [...new Set(roles.flatMap((role) => (role.capabilities as { capability: string }[]).map((capability) => capability.capability)))].sort() },
      migrations: { applied: migrations.map((migration) => migration.name).sort() },
      localWorker: workerDetails(workerSnapshot(k)), observedAt: new Date().toISOString(),
    };
  });

  app.post('/api/sys/diagnostics/authorization', async (req) => {
    const operator = (req as any).cageCtx as Ctx;
    requireOps(operator);
    const parsed = authorization.safeParse(req.body);
    if (!parsed.success) throw cageError('INVALID_INPUT', parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    const { command, input, userId } = parsed.data;
    const rc = k.registry.command(command);
    if (!rc) throw cageError('NOT_FOUND');
    let ctx = operator;
    if (userId && userId !== operator.userId) {
      const user = k.registry.aggregate('User');
      if (!user || !operator.capabilities.has('User.read') || !await loadScoped(k.app, user, userId, operator, false)) throw cageError('NOT_FOUND');
      const target = await k.contextFor(userId, operator.tenantId);
      if (!target) throw cageError('NOT_FOUND');
      ctx = target;
    }
    const agg = rc.cmd.agg;
    // 即使是运维人员，也不能利用解释接口探测其安全读范围以外的业务对象。
    if (rc.cmd.from !== 'new') {
      if (!operator.capabilities.has(`${agg.name}.read`) || !z.uuid().safeParse(input.id).success || !await loadScoped(k.app, agg, input.id as string, operator, false)) throw cageError('NOT_FOUND');
    }
    return k.explain(command, input, ctx);
  });

  app.get('/api/sys/diagnostics/timeline', async (req) => {
    const ctx = (req as any).cageCtx as Ctx;
    requireOps(ctx);
    const parsed = request.safeParse(req.query);
    if (!parsed.success) throw cageError('INVALID_INPUT', parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    const q = parsed.data;
    if (!q.requestId && !q.outboxId && !(q.aggregate && q.aggregateId)) throw cageError('INVALID_INPUT', '提供 requestId、outboxId 或 aggregate + aggregateId');
    let events = k.app.selectFrom('sys.outbox as o').select(['id','event','aggregate','aggregate_id','request_id','status','attempts','last_error','next_at','created_at','done_at']).where('o.tenant_id', '=', ctx.tenantId);
    if (q.requestId) events = events.where('request_id', '=', q.requestId);
    if (q.outboxId) events = events.where('id', '=', q.outboxId);
    if (q.aggregate) events = events.where('aggregate', '=', q.aggregate);
    if (q.aggregateId) events = events.where('aggregate_id', '=', q.aggregateId);
    const readable = k.registry.aggregates.filter((aggregate) => ctx.capabilities.has(`${aggregate.name}.read`));
    if (!readable.length) return { observedAt: new Date().toISOString(), truncated: false, events: [], audit: [] };
    // 在 LIMIT 之前过滤权限，既不会漏掉排在不可见事件之后的有效证据，也不泄露不可见事件的截断数量。
    events = events.where((eb) => eb.or(readable.map((aggregate) => eb.and([
      eb('aggregate', '=', aggregate.name),
      eb.exists(k.app.selectFrom(`${aggregate.table.schema}.${aggregate.table.name} as diagnostic_object`).select('diagnostic_object.id')
        .whereRef('diagnostic_object.id', '=', 'o.aggregate_id').where(compileScope(aggregate.scope, aggregate.name, ctx, 'diagnostic_object'))),
    ]))));
    const candidates = await events.orderBy('id').limit(201).execute();
    const visible = candidates.slice(0, 200);
    const ids = visible.map((event) => event.id);
    const [processed, calls, dead] = ids.length ? await Promise.all([
      k.app.selectFrom('sys.processed_event').selectAll().where('event_id', 'in', ids).execute(),
      k.app.selectFrom('sys.connector_execution').select(['outbox_id','consumer','connector','operation','status','attempts','error','updated_at']).where('tenant_id', '=', ctx.tenantId).where('outbox_id', 'in', ids).execute(),
      k.app.selectFrom('sys.dead_letter').select(['id','outbox_id','error','attempts','created_at','handled_at','resolution']).where('tenant_id', '=', ctx.tenantId).where('outbox_id', 'in', ids).execute(),
    ]) : [[], [], []];
    const audit = ctx.capabilities.has('Sys.audit.read') ? await k.read.tx(ctx, async (tx) => {
      if (!ids.length) return [];
      let query = tx.selectFrom('safe.audit_log').select(['id','at','actor','actor_kind','kind','capability','aggregate','aggregate_id','request_id','result']);
      const requestIds = [...new Set(visible.map((event) => event.request_id).filter((id): id is string => !!id))];
      if (!requestIds.length) return [];
      return query.where('request_id', 'in', requestIds).where((eb) => eb.or(visible.map((event) => eb.and([
        eb('aggregate', '=', event.aggregate), eb('aggregate_id', '=', event.aggregate_id),
      ])))).orderBy('at').limit(200).execute();
    }) : [];
    return {
      observedAt: new Date().toISOString(), truncated: candidates.length > 200,
      events: visible.map((event) => {
        const eventCalls = calls.filter((call) => call.outbox_id === event.id);
        // unknown 是持久化的远端结果隔离；重放 outbox 不会解除它，不能沿用普通死信操作建议。
        const nextAction = eventCalls.some((call) => call.status === 'unknown')
          ? '连接器远端结果未知，先人工核对；当前无通用解除 unknown 入口，普通死信重放不会解除。需连接器专用受控恢复或业务补偿'
          : event.status === 'dead' ? '检查死信原因后，经 Sys.ops.manage 重放或丢弃' : event.status === 'done' ? '已完成本次要求的消费者' : '等待 worker 处理；检查心跳、重试时间与错误码';
        return { ...event, last_error: failure(event.last_error), source: `/api/sys/ops/outbox`,
          consumers: processed.filter((entry) => entry.event_id === event.id),
          calls: eventCalls.map((call) => ({ ...call, error: failure(call.error) })),
          deadLetters: dead.filter((entry) => entry.outbox_id === event.id).map((entry) => ({ ...entry, error: failure(entry.error) })),
          nextAction,
        };
      }), audit,
    };
  });
}
