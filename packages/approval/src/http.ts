// 待办接口：GET /api/approval/tasks、POST /api/approval/tasks/:id/approve|reject
import { cageError, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { FastifyInstance } from 'fastify';
import type { InCodeEngine } from './engine.js';

export function approvalRoutes(app: FastifyInstance, opts: { kernel: Kernel; engines: InCodeEngine[]; ctxOf: (req: any) => Ctx }) {
  const user = (req: any) => {
    const ctx = opts.ctxOf(req);
    if (!ctx.actor || ctx.actor.kind !== 'user' || !ctx.userId) throw cageError('UNAUTHENTICATED');
    return ctx;
  };
  app.get('/api/approval/tasks', async (req) => {
    const ctx = user(req);
    const status = (req.query as any)?.status ?? 'pending';
    const lists = await Promise.all(opts.engines.map((e) => e.tasksOf(ctx.userId!, ctx.tenantId, status)));
    return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  for (const outcome of ['approve', 'reject'] as const) {
    app.post(`/api/approval/tasks/:id/${outcome}`, async (req) => {
      const ctx = user(req);
      const id = (req.params as any).id as string;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw cageError('NOT_FOUND');
      const comment = typeof (req.body as any)?.comment === 'string' ? String((req.body as any).comment).slice(0, 1000) : undefined;
      for (const e of opts.engines) {
        const owns = await opts.kernel.app.selectFrom('flow.approval_task as t').innerJoin('flow.approval_instance as i', 'i.id', 't.instance_id')
          .select('t.id').where('t.id', '=', id).where('i.process', '=', e.route.process).executeTakeFirst();
        if (owns) return e.decide(id, ctx.userId!, ctx.tenantId, outcome === 'approve' ? 'approved' : 'rejected', comment);
      }
      throw cageError('NOT_FOUND');
    });
  }
}
