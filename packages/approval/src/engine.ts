// 代码内封闭路由的引擎：流程实例和待办存在 flow 模式；结论通过桥接以流程身份调用命令。
// 审批人做出最后一个决定时，决定和结论命令在同一个事务里提交：命令被拒（例如超出额度）时决定也不生效。
import { cageError, type Kernel } from '@yss123/cage-kernel';
import { type ApprovalEngine } from '@yss123/cage-kernel/worker';
import { sql, type Transaction } from 'kysely';
import { applyOutcome } from './bridge.js';
import { resolveSteps, type Approver, type Route, type Step } from './route.js';

export interface TaskView {
  id: string;
  instanceId: string;
  process: string;
  aggregate: string;
  businessKey: string;
  step: number;
  title: string;
  status: string;
  vars: Record<string, unknown>;
  createdAt: string;
}

export class InCodeEngine implements ApprovalEngine {
  constructor(private readonly k: Kernel, readonly route: Route) {}

  private async approversOf(tx: Transaction<any>, a: Approver, vars: Record<string, unknown>, tenantId: string): Promise<string[]> {
    switch (a.kind) {
      case 'user':
        return [a.userId];
      case 'deptLeader': {
        const deptId = vars[a.field];
        if (typeof deptId !== 'string') return [];
        // 本部门没有负责人时沿祖先路径向上找
        const d = await tx.selectFrom('sys.dept').select(['leader_id', 'ancestors']).where('id', '=', deptId).where('tenant_id', '=', tenantId).executeTakeFirst();
        if (!d) return [];
        if (d.leader_id) return [d.leader_id];
        const ids = String(d.ancestors).split('/').filter(Boolean).reverse();
        for (const id of ids) {
          const p = await tx.selectFrom('sys.dept').select('leader_id').where('id', '=', id).executeTakeFirst();
          if (p?.leader_id) return [p.leader_id];
        }
        return [];
      }
      case 'role': {
        const role = await tx.selectFrom('sys.role').select('id').where('code', '=', a.code).where('tenant_id', '=', tenantId).where('status', '=', 'active').executeTakeFirst();
        if (!role) return [];
        const users = await tx
          .selectFrom('sys.user')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('status', '=', 'active')
          .where(sql<boolean>`role_ids @> ${JSON.stringify([role.id])}::jsonb`)
          .execute();
        return users.map((u) => u.id);
      }
      default:
        return [];
    }
  }

  private async openStep(tx: Transaction<any>, instanceId: string, tenantId: string, steps: Step[], index: number, vars: Record<string, unknown>) {
    const s = steps[index];
    const who = await this.approversOf(tx, s.approver, vars, tenantId);
    if (who.length === 0) {
      throw new Error(`[CAGE-APPR-007] 流程 ${this.route.process} 第 ${index + 1} 步「${s.title}」找不到审批人，请在 /admin 配置部门负责人或角色`);
    }
    for (const assignee of new Set(who)) {
      await tx.insertInto('flow.approval_task').values({ instance_id: instanceId, tenant_id: tenantId, step: index, title: s.title, assignee }).execute();
    }
  }

  async start(input: { process: string; businessKey: string; tenantId: string; vars: Record<string, unknown>; tx: Transaction<any> }) {
    const { tx } = input;
    const binding = this.k.registry.approvalByProcess(input.process);
    const steps = resolveSteps(this.route.nodes, input.vars);
    // 同一张单重新提交时，关闭旧的流程实例
    await tx.updateTable('flow.approval_instance').set({ status: 'superseded', updated_at: sql`now()` })
      .where('tenant_id', '=', input.tenantId).where('business_key', '=', input.businessKey).where('status', '=', 'running').execute();
    const inst = await tx
      .insertInto('flow.approval_instance')
      .values({
        tenant_id: input.tenantId, process: input.process, aggregate: binding?.a.agg.name ?? '', business_key: input.businessKey,
        vars: JSON.stringify(input.vars), steps: JSON.stringify(steps),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.openStep(tx, inst.id, input.tenantId, steps, 0, input.vars);
    return { instanceId: inst.id as string };
  }

  async cancel(input: { process: string; businessKey: string; tenantId: string; tx: Transaction<any> }) {
    const insts = await input.tx.selectFrom('flow.approval_instance').select('id')
      .where('tenant_id', '=', input.tenantId).where('business_key', '=', input.businessKey).where('status', '=', 'running').execute();
    for (const i of insts) {
      await input.tx.updateTable('flow.approval_instance').set({ status: 'cancelled', updated_at: sql`now()` }).where('id', '=', i.id).execute();
      await input.tx.updateTable('flow.approval_task').set({ status: 'cancelled' }).where('instance_id', '=', i.id).where('status', '=', 'pending').execute();
    }
  }

  /** 我的待办 */
  async tasksOf(userId: string, tenantId: string, status = 'pending'): Promise<TaskView[]> {
    const rows = await this.k.app
      .selectFrom('flow.approval_task as t')
      .innerJoin('flow.approval_instance as i', 'i.id', 't.instance_id')
      .select(['t.id', 't.instance_id', 'i.process', 'i.aggregate', 'i.business_key', 't.step', 't.title', 't.status', 'i.vars', 't.created_at'])
      .where('t.assignee', '=', userId)
      .where('t.tenant_id', '=', tenantId)
      .where('t.status', '=', status)
      .where('i.process', '=', this.route.process)
      .orderBy('t.created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id, instanceId: r.instance_id, process: r.process, aggregate: r.aggregate, businessKey: r.business_key,
      step: r.step, title: r.title, status: r.status, vars: r.vars, createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** 审批人做出决定；流程结束时在同一事务里执行结论命令 */
  async decide(taskId: string, userId: string, tenantId: string, outcome: 'approved' | 'rejected', comment?: string): Promise<{ finished: boolean; outcome?: string }> {
    return this.k.app.transaction().execute(async (tx) => {
      const task = await tx.selectFrom('flow.approval_task').selectAll()
        .where('id', '=', taskId).where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
      // 不是自己的待办一律 404，不泄露存在性
      if (!task || task.assignee !== userId) throw cageError('NOT_FOUND');
      if (task.status !== 'pending') throw cageError('INVALID_TRANSITION', { status: task.status });
      const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', task.instance_id).forUpdate().executeTakeFirstOrThrow();
      if (inst.status !== 'running') throw cageError('INVALID_TRANSITION', { status: inst.status });
      await tx.updateTable('flow.approval_task').set({ status: outcome, comment: comment ?? null, decided_at: sql`now()` }).where('id', '=', taskId).execute();
      const steps: Step[] = inst.steps;
      const finish = async (result: 'approved' | 'rejected') => {
        await tx.updateTable('flow.approval_task').set({ status: 'skipped' }).where('instance_id', '=', inst.id).where('status', '=', 'pending').execute();
        await tx.updateTable('flow.approval_instance').set({ status: result, last_approver: userId, updated_at: sql`now()` }).where('id', '=', inst.id).execute();
        await applyOutcome(this.k, { process: inst.process, tenantId, businessKey: inst.business_key, outcome: result, lastApprover: userId }, tx);
        return { finished: true, outcome: result };
      };
      if (outcome === 'rejected') return finish('rejected');
      const s = steps[task.step];
      if (s.mode === 'all') {
        const left = await tx.selectFrom('flow.approval_task').select('id')
          .where('instance_id', '=', inst.id).where('step', '=', task.step).where('status', '=', 'pending').execute();
        if (left.length > 0) return { finished: false };
      } else {
        await tx.updateTable('flow.approval_task').set({ status: 'skipped' })
          .where('instance_id', '=', inst.id).where('step', '=', task.step).where('status', '=', 'pending').execute();
      }
      const nextIndex = task.step + 1;
      if (nextIndex >= steps.length) return finish('approved');
      await tx.updateTable('flow.approval_instance').set({ current_step: nextIndex, last_approver: userId, updated_at: sql`now()` }).where('id', '=', inst.id).execute();
      await this.openStep(tx, inst.id, tenantId, steps, nextIndex, inst.vars);
      return { finished: false };
    });
  }
}
