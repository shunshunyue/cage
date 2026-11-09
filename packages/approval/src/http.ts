// 待办接口：本人/候选查询、领取释放、决定、转办、委派归还、前后/并行加签和操作历史；身份来自宿主会话。
import { cageError, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { FastifyInstance } from 'fastify';
import type { InCodeEngine } from './engine.js';
import { taskActionSchema } from './task-actions.js';
import { z } from 'zod';
import { approvalDecisionSchema } from './openapi.js';
import { approvalOperationsService } from './operations.js';
import { approvalNoticeQuerySchema, approvalUrgeSchema } from './operations-schema.js';

/**
 * 在宿主 Fastify 会话/CSRF 边界内注册我的待办、对象审批历史及三种人工决定接口。
 * 路由只接受真人用户，历史先验证对象 read；决定由目标引擎再次核对租户、待办归属、当前步骤和能力。
 * 多个引擎的待办按时间合并，意见最多 1000 字；新操作和决定输入严格校验，不静默裁剪意见。
 * 任务操作按租户定位引擎后交给引擎加锁/授权，历史显式指定 process 并使用游标分页。
 */
export function approvalRoutes(app: FastifyInstance, opts: { kernel: Kernel; engines: InCodeEngine[]; ctxOf: (req: any) => Ctx }) {
  const user = (req: any) => {
    const ctx = opts.ctxOf(req);
    if (!ctx.actor || ctx.actor.kind !== 'user' || !ctx.userId) throw cageError('UNAUTHENTICATED');
    return ctx;
  };
  // 仅显式导出的运行时开放站内流程运营；未启用的旧应用仍只有原审批接口。
  if (opts.kernel.registry.extensions.some(e => e.kind === 'RUNTIME' && e.value.name === 'approval-operations')) {
    const operations = approvalOperationsService(opts.kernel);
    app.get('/api/approval/notices', async req => {
      const ctx = user(req), parsed = approvalNoticeQuerySchema.safeParse(req.query);
      if (!parsed.success) throw cageError('INVALID_INPUT');
      return operations.notices(ctx, parsed.data);
    });
    app.get('/api/approval/requests', async req => operations.requests(user(req)));
    app.post('/api/approval/notices/:id/read', async req => {
      const ctx = user(req), id = (req.params as { id: string }).id;
      if (!z.strictObject({}).safeParse(req.body ?? {}).success) throw cageError('INVALID_INPUT');
      return operations.readNotice(id, ctx);
    });
    app.post('/api/approval/instances/:id/urge', async req => {
      const ctx = user(req), id = (req.params as { id: string }).id, parsed = approvalUrgeSchema.safeParse(req.body);
      if (!z.uuid().safeParse(id).success || !parsed.success) throw cageError('INVALID_INPUT');
      return operations.urge(id, ctx, parsed.data);
    });
  }
  /** 只从当前租户的已注册流程定位引擎，不以客户端传入的流程名更改待办归属。 */
  const engineForTask = async (id: string, tenantId: string) => {
    if (!z.uuid().safeParse(id).success) throw cageError('NOT_FOUND');
    const row = await opts.kernel.app.selectFrom('flow.approval_task as t').innerJoin('flow.approval_instance as i', 'i.id', 't.instance_id')
      .select('i.process').where('t.id', '=', id).where('t.tenant_id', '=', tenantId).where('i.tenant_id', '=', tenantId).executeTakeFirst();
    const engine = opts.engines.find(e => e.route.process === row?.process);
    if (!engine) throw cageError('NOT_FOUND');
    return engine;
  };
  app.get('/api/approval/tasks', async (req) => {
    const ctx = user(req);
    const status = (req.query as any)?.status ?? 'pending';
    const lists = await Promise.all(opts.engines.map((e) => e.tasksOf(ctx.userId!, ctx.tenantId, status)));
    return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  app.get('/api/approval/candidate-tasks', async req => {
    const ctx = user(req);
    const lists = await Promise.all(opts.engines.map(engine => engine.candidateTasks(ctx.userId!, ctx.tenantId)));
    return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  app.get('/api/approval/history/:aggregate/:id', async req => {
    const ctx = user(req), params = req.params as { aggregate: string; id: string };
    await opts.kernel.read.get(params.aggregate, params.id, ctx);
    return (await Promise.all(opts.engines.map(engine => engine.history(params.aggregate, params.id, ctx)))).flat();
  });
  app.get('/api/approval/task-history/:process/:aggregate/:id', async req => {
    const ctx = user(req), params = req.params as { process: string; aggregate: string; id: string };
    const parsed = z.strictObject({ after: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).safeParse(req.query);
    if (!parsed.success) throw cageError('INVALID_INPUT');
    const engine = opts.engines.find(e => e.route.process === params.process);
    if (!engine) throw cageError('NOT_FOUND');
    return engine.taskHistory(params.aggregate, params.id, ctx, parsed.data);
  });
  for (const [path, action] of [['transfer', 'transfer'], ['delegate', 'delegate'], ['resolve', 'resolve'], ['add-sign', 'addSign'], ['claim', 'claim'], ['unclaim', 'unclaim']] as const) {
    app.post(`/api/approval/tasks/:id/${path}`, async req => {
      const ctx = user(req), id = (req.params as { id: string }).id;
      // action 固定来自路由；拒绝请求体伪造同名字段或非对象输入。
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || 'action' in req.body) throw cageError('INVALID_INPUT');
      const parsed = taskActionSchema.safeParse({ ...req.body, action });
      if (!parsed.success) throw cageError('INVALID_INPUT');
      return (await engineForTask(id, ctx.tenantId)).act(id, ctx.userId!, ctx.tenantId, parsed.data);
    });
  }
  for (const outcome of ['approve', 'reject', 'return'] as const) {
    app.post(`/api/approval/tasks/:id/${outcome}`, async (req) => {
      const ctx = user(req);
      const id = (req.params as any).id as string;
      const parsed = approvalDecisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw cageError('INVALID_INPUT');
      return (await engineForTask(id, ctx.tenantId)).decide(id, ctx.userId!, ctx.tenantId,
        outcome === 'approve' ? 'approved' : outcome === 'return' ? 'returned' : 'rejected', parsed.data.comment, parsed.data.expectedRevision);
    });
  }
}
