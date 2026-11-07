// 代码内封闭路由的引擎：流程实例和待办存在 flow 模式；结论通过桥接以流程身份调用命令。
// 审批人做出最后一个决定时，决定和结论命令在同一个事务里提交：命令被拒（例如超出额度）时决定也不生效。
import { cageError, grantsFor, stableStringify, type Kernel, type Ctx } from '@yss123/cage-kernel';
import { type ApprovalEngine } from '@yss123/cage-kernel/worker';
import { sql, type Transaction } from 'kysely';
import { applyOutcome } from './bridge.js';
import { resolveSteps, type Approver, type Route, type ApprovalStep } from './route.js';
import { approvalRoleContext, type AiDecision } from './ai.js';

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

  private async openStep(tx: Transaction<any>, instanceId: string, tenantId: string, steps: ApprovalStep[], index: number, vars: Record<string, unknown>, version?: number) {
    const s = steps[index];
    if (!s) throw new Error('[CAGE-APPR-006] 审批路由未展开出任何步骤');
    await tx.insertInto('flow.approval_step').values({ instance_id: instanceId, tenant_id: tenantId, step: index,
      kind: s.kind === 'ai' ? 'ai' : 'human', status: s.kind === 'ai' ? 'queued' : 'running', expected_version: version ?? null }).execute();
    if (s.kind === 'ai') return;
    await this.openTasks(tx, instanceId, tenantId, index, s.title, s.approver, vars);
  }

  private async openTasks(tx: Transaction<any>, instanceId: string, tenantId: string, index: number, title: string, selector: Approver, vars: Record<string, unknown>) {
    const who = await this.approversOf(tx, selector, vars, tenantId);
    if (who.length === 0) {
      throw new Error(`[CAGE-APPR-007] 流程 ${this.route.process} 第 ${index + 1} 步「${title}」找不到审批人，请在 /admin 配置部门负责人或角色`);
    }
    for (const assignee of new Set(who)) {
      await tx.insertInto('flow.approval_task').values({ instance_id: instanceId, tenant_id: tenantId, step: index, title, assignee }).execute();
    }
  }

  async start(input: { process: string; businessKey: string; tenantId: string; vars: Record<string, unknown>; tx: Transaction<any>; subjectVersion?: number; eventId?: number }) {
    const { tx } = input;
    const binding = this.k.registry.approvalByProcess(input.process);
    const steps = resolveSteps(this.route.nodes, input.vars);
    // 重提关闭旧轮次的所有执行者；旧 AI 回执不能继续推进新流程。
    await this.cancel({ ...input });
    const inst = await tx
      .insertInto('flow.approval_instance')
      .values({
        tenant_id: input.tenantId, process: input.process, aggregate: binding?.a.agg.name ?? '', business_key: input.businessKey,
        vars: JSON.stringify(input.vars), steps: JSON.stringify(steps),
        subject_version: input.subjectVersion ?? null, start_event_id: input.eventId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (input.subjectVersion && binding) {
      const current = await tx.selectFrom(`${binding.a.agg.table.schema}.${binding.a.agg.table.name}`).select('version')
        .where('id', '=', input.businessKey).where('tenant_id', '=', input.tenantId).executeTakeFirst();
      if (!current || current.version !== input.subjectVersion) {
        await tx.updateTable('flow.approval_instance').set({ status: 'superseded' }).where('id', '=', inst.id).execute();
        return { instanceId: inst.id as string };
      }
    }
    await this.openStep(tx, inst.id, input.tenantId, steps, 0, input.vars, input.subjectVersion);
    return { instanceId: inst.id as string };
  }

  async cancel(input: { process: string; businessKey: string; tenantId: string; tx: Transaction<any> }) {
    const insts = await input.tx.selectFrom('flow.approval_instance').select('id')
      .where('tenant_id', '=', input.tenantId).where('process', '=', input.process).where('business_key', '=', input.businessKey).where('status', '=', 'running').execute();
    for (const i of insts) {
      await input.tx.updateTable('flow.approval_instance').set({ status: 'cancelled', updated_at: sql`now()` }).where('id', '=', i.id).execute();
      await input.tx.updateTable('flow.approval_task').set({ status: 'cancelled' }).where('instance_id', '=', i.id).where('status', '=', 'pending').execute();
      await input.tx.updateTable('flow.approval_step').set({ status: 'cancelled', updated_at: sql`now()` }).where('instance_id', '=', i.id)
        .where('status', 'in', ['queued', 'running', 'waiting_manual', 'failed']).execute();
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
      .$if(status === 'pending', qb => qb.where('i.status', '=', 'running'))
      .where('i.process', '=', this.route.process)
      .orderBy('t.created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id, instanceId: r.instance_id, process: r.process, aggregate: r.aggregate, businessKey: r.business_key,
      step: r.step, title: r.title, status: r.status, vars: r.vars, createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** 以业务对象读权限查看审批轮次；隐藏内部 policy、提示词、工具历史和运行凭据。 */
  async history(aggregate: string, businessKey: string, ctx: Ctx) {
    const binding = this.k.registry.approvalByProcess(this.route.process)?.a;
    if (binding?.agg.name !== aggregate) return [];
    await this.k.read.get(aggregate, businessKey, ctx);
    const instances = await this.k.app.selectFrom('flow.approval_instance').select(['id', 'status', 'current_step', 'created_at', 'updated_at'])
      .where('tenant_id', '=', ctx.tenantId).where('process', '=', this.route.process).where('business_key', '=', businessKey).orderBy('created_at', 'desc').limit(50).execute();
    const result = [];
    for (const instance of instances) {
      const steps = await this.k.app.selectFrom('flow.approval_step').select(['step', 'kind', 'status', 'decision', 'decision_visibility', 'actor', 'created_at', 'updated_at'])
        .where('instance_id', '=', instance.id).orderBy('step').execute();
      result.push({ id: instance.id, process: this.route.process, status: instance.status, currentStep: instance.current_step,
        createdAt: new Date(instance.created_at).toISOString(), updatedAt: new Date(instance.updated_at).toISOString(),
        steps: steps.map(s => {
          // 生成的理由也可能包含关联查询或敏感明文，不能只按单据可见就向低权限读者披露。
          const visibility = s.decision_visibility;
          const allowed = !visibility || (visibility.unmask.every((kind: string) => ctx.unmask.includes(kind)) && visibility.queries.every((q: any) =>
            ctx.capabilities.has(`${q.aggregate}.read`) && (grantsFor(ctx, q.aggregate).some(g => g.combinator === 'all') ||
              (visibility.userId === ctx.userId && stableStringify(grantsFor(ctx, q.aggregate)) === stableStringify(q.scopes)))));
          return { index: s.step, kind: s.kind, status: s.status, decision: allowed ? s.decision : null, detailRestricted: !allowed, actor: s.actor, updatedAt: new Date(s.updated_at).toISOString() };
        }) });
    }
    return result;
  }

  /** 审批人做出决定；流程结束时在同一事务里执行结论命令 */
  async decide(taskId: string, userId: string, tenantId: string, outcome: 'approved' | 'rejected' | 'returned', comment?: string): Promise<{ finished: boolean; outcome?: string }> {
    return this.k.app.transaction().execute(tx => this.decideIn(tx, taskId, userId, tenantId, outcome, comment));
  }

  /** AI 助理的动作回执可与人工待办决定共用该事务，重试不重复审批。 */
  async decideIn(tx: Transaction<any>, taskId: string, userId: string, tenantId: string, outcome: 'approved' | 'rejected' | 'returned', comment?: string): Promise<{ finished: boolean; outcome?: string }> {
      const candidate = await tx.selectFrom('flow.approval_task').select(['instance_id', 'assignee']).where('id', '=', taskId).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!candidate || candidate.assignee !== userId) throw cageError('NOT_FOUND');
      const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', candidate.instance_id).where('process', '=', this.route.process).forUpdate().executeTakeFirst();
      if (!inst || inst.status !== 'running') throw cageError('INVALID_TRANSITION');
      const actor = await this.k.contextFor(userId, tenantId), binding = this.k.registry.approvalByProcess(inst.process)!.a;
      const command = outcome === 'approved' ? binding.onApproved : outcome === 'returned' ? binding.onReturned : binding.onRejected;
      if (!actor || !command || !actor.capabilities.has(this.k.registry.capabilityOf(command))) throw cageError('FORBIDDEN');
      await this.k.read.get(binding.agg, inst.business_key, actor);
      const task = await tx.selectFrom('flow.approval_task').selectAll().where('id', '=', taskId).forUpdate().executeTakeFirst();
      // 不是自己的待办一律 404，不泄露存在性
      if (!task || task.assignee !== userId) throw cageError('NOT_FOUND');
      if (task.status !== 'pending') throw cageError('INVALID_TRANSITION', { status: task.status });
      if (task.step !== inst.current_step) throw cageError('INVALID_TRANSITION');
      await tx.updateTable('flow.approval_task').set({ status: outcome, comment: comment ?? null, decided_at: sql`now()` }).where('id', '=', taskId).execute();
      const steps: ApprovalStep[] = inst.steps;
      if (outcome !== 'approved') return this.finish(tx, inst, outcome, userId);
      const s = steps[task.step];
      if (s.kind !== 'ai' && s.mode === 'all') {
        const left = await tx.selectFrom('flow.approval_task').select('id')
          .where('instance_id', '=', inst.id).where('step', '=', task.step).where('status', '=', 'pending').execute();
        if (left.length > 0) return { finished: false };
      } else {
        await tx.updateTable('flow.approval_task').set({ status: 'skipped' })
          .where('instance_id', '=', inst.id).where('step', '=', task.step).where('status', '=', 'pending').execute();
      }
      return this.advance(tx, inst, userId);
  }

  private async finish(tx: Transaction<any>, inst: any, result: 'approved' | 'rejected' | 'returned', userId?: string) {
    await applyOutcome(this.k, { process: inst.process, tenantId: inst.tenant_id, businessKey: inst.business_key, outcome: result,
      lastApprover: userId, expectedVersion: inst.subject_version ?? undefined }, tx);
    await tx.updateTable('flow.approval_task').set({ status: 'skipped' }).where('instance_id', '=', inst.id).where('status', '=', 'pending').execute();
    await tx.updateTable('flow.approval_step').set({ status: result, updated_at: sql`now()` }).where('instance_id', '=', inst.id).where('step', '=', inst.current_step).execute();
    await tx.updateTable('flow.approval_instance').set({ status: result, last_approver: userId ?? null,
      last_actor: JSON.stringify(userId ? { kind: 'user', id: userId } : { kind: 'process', id: inst.process }), updated_at: sql`now()` }).where('id', '=', inst.id).execute();
    return { finished: true, outcome: result };
  }

  private async advance(tx: Transaction<any>, inst: any, userId?: string) {
    await tx.updateTable('flow.approval_step').set({ status: 'approved', updated_at: sql`now()` }).where('instance_id', '=', inst.id).where('step', '=', inst.current_step).execute();
    const steps: ApprovalStep[] = inst.steps;
    const next = inst.current_step + 1;
    if (next >= steps.length) return this.finish(tx, inst, 'approved', userId);
    await tx.updateTable('flow.approval_instance').set({ current_step: next, last_approver: userId ?? null, updated_at: sql`now()` }).where('id', '=', inst.id).execute();
    await this.openStep(tx, inst.id, inst.tenant_id, steps, next, inst.vars, inst.subject_version ?? undefined);
    return { finished: false };
  }

  /** 只有仍然占据该节点的 run 能提交；调用方需在同一事务核验 AI run 租约。 */
  async completeAi(tx: Transaction<any>, stepId: string, runId: string, decision: AiDecision, actor?: Ctx) {
    const ref = await tx.selectFrom('flow.approval_step').select('instance_id').where('id', '=', stepId).executeTakeFirstOrThrow();
    const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', ref.instance_id).where('process', '=', this.route.process).forUpdate().executeTakeFirstOrThrow();
    const current = await tx.selectFrom('flow.approval_step').selectAll().where('id', '=', stepId).forUpdate().executeTakeFirstOrThrow();
    if (inst.status !== 'running' || current.step !== inst.current_step || current.run_id !== runId || !['running', 'queued'].includes(current.status)) throw cageError('CONFLICT');
    const node = (inst.steps as ApprovalStep[])[current.step];
    if (node.kind !== 'ai') throw cageError('INVALID_TRANSITION');
    // 中间 AI 步骤同样检查提交版本，防止旧判定推进新内容；最后的命令仍进行版本校验。
    const binding = this.k.registry.approvalByProcess(inst.process)!.a;
    const subject = await tx.selectFrom(`${binding.agg.table.schema}.${binding.agg.table.name}`).select('version')
      .where('id', '=', inst.business_key).where('tenant_id', '=', inst.tenant_id).forUpdate().executeTakeFirst();
    if (!subject || (inst.subject_version !== null && subject.version !== inst.subject_version)) throw cageError('CONFLICT');
    const who = actor?.actor ?? (decision.decision === 'manual' ? { kind: 'process', id: `process:${inst.process}:handoff` }
      : (await approvalRoleContext(this.k, inst.process, inst.tenant_id)).actor);
    const queryReads = [...new Set((node.context.queries ?? []).flatMap(name => this.k.registry.queries.find(q => q.name === name)?.reads.map(a => a.name) ?? []))];
    const visibility = actor ? { userId: actor.userId, unmask: actor.unmask, queries: queryReads.map(aggregate => ({ aggregate, scopes: grantsFor(actor, aggregate) })) } : null;
    await tx.updateTable('flow.approval_step').set({ decision: JSON.stringify(decision), decision_visibility: JSON.stringify(visibility), actor: JSON.stringify(who), updated_at: sql`now()` }).where('id', '=', stepId).execute();
    if (decision.decision === 'manual') {
      await this.openTasks(tx, inst.id, inst.tenant_id, current.step, node.title, node.handoff, inst.vars);
      await tx.updateTable('flow.approval_step').set({ status: 'waiting_manual' }).where('id', '=', stepId).execute();
      return { finished: false };
    }
    if (decision.decision === 'return') return this.finish(tx, inst, 'returned');
    return this.advance(tx, inst);
  }
}
