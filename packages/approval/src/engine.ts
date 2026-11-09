/**
 * 原生结构化审批执行器：实例、AND 分支、候选/直派任务及签署阶段存在 flow 模式，结论经桥接调用领域命令。
 * HTTP、worker 和 AI 运行时共用本入口；按实例锁串行决定，前后签激活与最后结论共同事务提交。
 * waiting 不是完成；任务选人不授予能力，最后命令拒绝（如超额度）会回滚本次决定及附带变化。
 */
import { cageError, grantsFor, present, stableStringify, type Kernel, type Ctx } from '@yss123/cage-kernel';
import { type ApprovalEngine } from '@yss123/cage-kernel/worker';
import { sql, type Transaction } from 'kysely';
import { applyOutcome } from './bridge.js';
import { type Approver, type Route, type ApprovalStep } from './route.js';
import { compileSteps, dependencies, ACTIVE_STEP_STATUSES, type BranchLocation, type ExecutableStep } from './execution.js';
import { approvalRoleContext, type AiDecision } from './ai.js';
import { authorizedTaskActor, executeTaskAction, lockOwnedTask, recordTaskAction, type TaskActionInput, type TaskActionPolicy } from './task-actions.js';
import { resolveApprovers } from './selectors.js';
import { activateSignatures } from './task-stages.js';
import { initializeDeadline } from './deadlines.js';
import { z } from 'zod';

/** 对外待办摘要；step 为 0 基索引，vars 仅来自 routable 白名单，不包含整份领域对象。 */
export interface TaskView {
  id: string;
  instanceId: string;
  process: string;
  aggregate: string;
  businessKey: string;
  step: number;
  title: string;
  /** 所属并行组/分支路径；普通主线或旧顺序实例为空数组，不把索引大小当作实际执行先后。 */
  branchPath: BranchLocation[];
  status: string;
  vars: Record<string, unknown>;
  createdAt: string;
  /** 节点总办理截止 UTC 时间；无 SLA 为 null，waiting 或转办不重置，不代表自动批准时间。 */
  dueAt: string | null;
  /** 待办版本，启用任务流转的节点提交决定时也必须携带。 */
  revision: number;
  /** 当前持有人；候选池待领取时为空。 */
  assigneeId: string | null;
  /** direct 直接分配，candidate 允许当前候选领取/持有人释放。 */
  assignment: 'direct' | 'candidate';
  /** 加签来源任务；旧并行加签和原始任务可为空。 */
  parentTaskId: string | null;
  /** 相对父任务的签署顺序；null 表示原票或旧版未记录签序。 */
  signPosition: 'parallel' | 'before' | 'after' | null;
  /** 实例允许的新加签位置；未开放为 []，第一批旧快照仅 parallel，不表示本任务可以再次加签。 */
  signPositions: readonly ('parallel' | 'before' | 'after')[];
  /** 委派原负责人；未委派或已转办时为空。 */
  ownerId: string | null;
  /** pending 表示受托处理中，只能归还；resolved 表示已归还原负责人。 */
  delegation: 'pending' | 'resolved' | null;
  /** original 是路由选人，additional 是节点前后/并行追加必签。 */
  taskKind: 'original' | 'additional';
  /** 实例快照中的动作政策，仅供界面显示；服务端仍会实时授权。 */
  actions: Readonly<TaskActionPolicy>;
}

/**
 * 有限无环路由的持久执行器：实例冻结展开步骤与依赖，人工任务和 AI 节点共享同一推进/结束边界。
 * 以实例行锁串行化决定，最后结论与领域命令共同事务提交；命令失败时本次审批也不能算完成。
 */
export class InCodeEngine implements ApprovalEngine {
  constructor(private readonly k: Kernel, readonly route: Route) {}

  /**
   * 执行候选领取/释放或本人待办转办/委派/归还/前后加签；必需任务版本与原因，失败不会部分更新。
   * 分配或动作政策须显式启用，接收人须已有批准和读取权限；返回版本及新任务 ID，不推进领域状态。
   */
  async act(taskId: string, userId: string, tenantId: string, input: TaskActionInput) {
    return executeTaskAction(this.k, this.route.process, taskId, userId, tenantId, input);
  }

  /** 登记当前节点与提交版本；AI 节点排队等待运行时领取，人工节点立即解析候选并创建待办。 */
  private async openStep(tx: Transaction<any>, instanceId: string, tenantId: string, steps: ApprovalStep[], index: number, vars: Record<string, unknown>, version?: number) {
    const s = steps[index];
    if (!s) throw new Error('[CAGE-APPR-006] 审批路由未展开出任何步骤');
    await tx.insertInto('flow.approval_step').values({ instance_id: instanceId, tenant_id: tenantId, step: index,
      kind: s.kind === 'ai' ? 'ai' : 'human', status: s.kind === 'ai' ? 'queued' : 'running', expected_version: version ?? null }).execute();
    if (s.kind === 'ai') return;
    if (s.sla) await initializeDeadline(tx, instanceId, index, s.sla);
    await this.openTasks(tx, instanceId, tenantId, index, s.title, s.approver, vars, s.assignment);
  }

  /** direct 逐人建立票，candidate 只建一项未领取任务；空候选明确报错，不跳过或默认通过。 */
  private async openTasks(tx: Transaction<any>, instanceId: string, tenantId: string, index: number, title: string, selector: Approver, vars: Record<string, unknown>, assignment: 'direct' | 'candidate' = 'direct') {
    const who = await resolveApprovers(tx, selector, vars, tenantId);
    if (who.length === 0) {
      throw new Error(`[CAGE-APPR-007] 流程 ${this.route.process} 第 ${index + 1} 步「${title}」找不到审批人，请在 /admin 配置部门负责人或角色`);
    }
    if (selector.kind === 'field' || assignment === 'candidate') {
      // 新字段/候选声明不允许创建指向停用或其他租户账号的票；整批拒绝，不静默减少会签人数。
      // 这里仅核对账号有效性，业务批准/read/范围仍在领取和执行时实时校验，不授予权限。
      const users = await tx.selectFrom('sys.user').select('id').where('id', 'in', [...new Set(who)])
        .where('tenant_id', '=', tenantId).where('status', '=', 'active').execute();
      if (users.length !== new Set(who).size) throw new Error('[CAGE-APPR-007] 审批人员必须全部为当前租户的启用用户');
    }
    for (const assignee of assignment === 'candidate' ? [null] : new Set(who)) {
      // 直派沿用旧 INSERT 形状；新库由列默认值赋 direct，升级前的旧表也可创建基线任务。
      await tx.insertInto('flow.approval_task').values({ instance_id: instanceId, tenant_id: tenantId, step: index, title, assignee,
        ...(assignment === 'candidate' ? { assignment } : {}) }).execute();
    }
  }

  /**
   * 在消费事务中创建新轮次：先取消旧执行者，再保存展开步骤和触发事件/提交版本。
   * 事件版本已落后于当前对象时标 superseded 而不创建新待办，防止迟到提交事件审核过期内容。
   */
  async start(input: { process: string; businessKey: string; tenantId: string; vars: Record<string, unknown>; tx: Transaction<any>; subjectVersion?: number; eventId?: number }) {
    const { tx } = input;
    // 申请人身份必须由有效单个 UUID 快照明确指定；在取消旧轮次之前拒绝错误配置，不能留下无人可催办的新轮次。
    // 这里只核对标识形状，当前用户是否有效、申请人是否有读取范围等仍在请求清单/催办时实时核验。
    if (this.route.reminders && !z.uuid().safeParse(input.vars[this.route.reminders.requesterField]).success)
      throw cageError('INVALID_INPUT', { reason: '催办申请人字段必须是单个用户 UUID' });
    const binding = this.k.registry.approvalByProcess(input.process);
    const steps = compileSteps(this.route.nodes, input.vars, this.route.definitionVersion);
    // 重提关闭旧轮次的所有执行者；旧 AI 回执不能继续推进新流程。
    await this.cancel({ ...input });
    const inst = await tx
      .insertInto('flow.approval_instance')
      .values({
        tenant_id: input.tenantId, process: input.process, aggregate: binding?.a.agg.name ?? '', business_key: input.businessKey,
        vars: JSON.stringify(input.vars), steps: JSON.stringify(steps),
        subject_version: input.subjectVersion ?? null, start_event_id: input.eventId ?? null,
        // 只在新政策实际启用时追加列，旧迁移基线夹具仍可创建无运营政策的原始实例。
        ...(this.route.reminders ? { reminder_policy: JSON.stringify(this.route.reminders) } : {}),
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
    // 所有无前驱的分支入口同事务创建；任何入口选人失败都会回滚本轮创建，不能偷偷减少会审分支。
    for (let index = 0; index < steps.length; index++) if (dependencies(steps, index).length === 0)
      await this.openStep(tx, inst.id, input.tenantId, steps, index, input.vars, input.subjectVersion);
    return { instanceId: inst.id as string };
  }

  /** 关闭同租户/流程/对象的 running 轮次、未决待办和可运行 AI 节点，已完成历史保持可追溯。 */
  async cancel(input: { process: string; businessKey: string; tenantId: string; tx: Transaction<any> }) {
    const insts = await input.tx.selectFrom('flow.approval_instance').select(['id', 'tenant_id'])
      .where('tenant_id', '=', input.tenantId).where('process', '=', input.process).where('business_key', '=', input.businessKey).where('status', '=', 'running').forUpdate().execute();
    for (const i of insts) {
      await input.tx.updateTable('flow.approval_instance').set({ status: 'cancelled', updated_at: sql`now()` }).where('id', '=', i.id).execute();
      await input.tx.updateTable('flow.approval_task').set({ status: 'cancelled', revision: sql`revision + 1` }).where('instance_id', '=', i.id).where('status', 'in', ['pending', 'waiting']).execute();
      await recordTaskAction(input.tx, i, null, null, 'cancelled', null);
      await input.tx.updateTable('flow.approval_step').set({ status: 'cancelled', next_notice_scan_at: null, updated_at: sql`now()` }).where('instance_id', '=', i.id)
        .where('status', 'in', ['queued', 'running', 'waiting_manual', 'failed']).execute();
    }
  }

  /**
   * 从本人最近 200 条任务候选中按当前单据 read/范围过滤，撤权或停用后不继续披露任务摘要。
   * vars 是历史 routable 摘要，始终去隐藏字段并掩码；需要明文时另经带审计的业务读接口获取。
   */
  async tasksOf(userId: string, tenantId: string, status = 'pending'): Promise<TaskView[]> {
    return this.listTasks(userId, tenantId, status, false);
  }

  /**
   * 查询最近 200 项未领取候选中的可见任务；当前候选身份与批准/read 权限均需成立。
   * 列表不是占用承诺，领取必须再次锁定并校验；待领取任务不会混入 tasksOf/AI 的可决定清单。
   */
  async candidateTasks(userId: string, tenantId: string): Promise<TaskView[]> {
    return this.listTasks(userId, tenantId, 'pending', true);
  }

  /** 共用安全摘要投影；候选规则在读取时解析，组织变化即时影响候选清单，历史变量仍始终掩码。 */
  private async listTasks(userId: string, tenantId: string, status: string, candidates: boolean): Promise<TaskView[]> {
    const binding = this.k.registry.approvalByProcess(this.route.process)?.a;
    const actor = await this.k.contextFor(userId, tenantId);
    if (!binding || !actor?.capabilities.has(`${binding.agg.name}.read`)) return [];
    if (candidates && !actor.capabilities.has(this.k.registry.capabilityOf(binding.onApproved))) return [];
    const rows = await this.k.app
      .selectFrom('flow.approval_task as t')
      .innerJoin('flow.approval_instance as i', 'i.id', 't.instance_id')
      .innerJoin('flow.approval_step as s', join => join.onRef('s.instance_id', '=', 'i.id').onRef('s.step', '=', 't.step'))
      .select(['t.id', 't.instance_id', 'i.process', 'i.aggregate', 'i.business_key', 'i.steps', 't.step', 't.title', 't.status', 'i.vars', 't.created_at', 't.revision', 't.owner_id', 't.delegation', 't.task_kind', 't.assignee', 't.assignment', 't.parent_task_id', 't.sign_position', 's.due_at'])
      .$if(!candidates, query => query.where('t.assignee', '=', userId))
      .$if(candidates, query => query.where('t.assignment', '=', 'candidate').where('t.assignee', 'is', null).where('s.status', 'in', [...ACTIVE_STEP_STATUSES]))
      .where('t.tenant_id', '=', tenantId)
      .where('t.status', '=', status)
      .$if(status === 'pending', qb => qb.where('i.status', '=', 'running'))
      .where('i.process', '=', this.route.process)
      .orderBy('t.created_at', 'desc')
      .limit(200)
      .execute();
    if (!rows.length) return [];
    // 一个安全视图查询覆盖本页对象；只检查可见性，不为历史变量绕过字段掩码或借读取明文授予权限。
    const visible = await this.k.read.tx(actor, read => read.selectFrom(`safe.${binding.agg.table.name}`).select('id')
      .where('id', 'in', [...new Set(rows.map(r => r.business_key))]).execute());
    const ids = new Set(visible.map(r => r.id));
    const eligible = [];
    for (const row of rows.filter(r => ids.has(r.business_key))) {
      if (candidates) {
        const node: ApprovalStep = row.steps[row.step];
        if (node.kind === 'ai' || node.assignment !== 'candidate' || !(await resolveApprovers(this.k.app, node.approver, row.vars, tenantId)).includes(userId)) continue;
        const peer = await this.k.app.selectFrom('flow.approval_task').select('id').where('instance_id', '=', row.instance_id).where('step', '=', row.step)
          .where(q => q.or([q('assignee', '=', userId), q('owner_id', '=', userId)])).executeTakeFirst();
        if (peer) continue;
      }
      eligible.push(row);
    }
    return eligible.map((r) => ({
      id: r.id, instanceId: r.instance_id, process: r.process, aggregate: r.aggregate, businessKey: r.business_key,
      step: r.step, title: r.title, status: r.status, vars: present(binding.agg, r.vars, null), createdAt: new Date(r.created_at).toISOString(),
      branchPath: (r.steps as ExecutableStep[])[r.step].execution?.branchPath ?? [],
      dueAt: r.due_at == null ? null : new Date(r.due_at).toISOString(),
      revision: r.revision, ownerId: r.owner_id, delegation: r.delegation, taskKind: r.task_kind,
      assigneeId: r.assignee, assignment: r.assignment, parentTaskId: r.parent_task_id, signPosition: r.sign_position,
      signPositions: r.steps[r.step]?.actions?.addSign ? r.steps[r.step].signPositions ?? ['parallel'] : [],
      actions: r.steps[r.step]?.actions ?? {},
    }));
  }

  /** 以业务对象读权限查看审批轮次；步骤标题取提交时的快照，隐藏内部 policy、提示词、工具历史和运行凭据。 */
  async history(aggregate: string, businessKey: string, ctx: Ctx) {
    const binding = this.k.registry.approvalByProcess(this.route.process)?.a;
    if (binding?.agg.name !== aggregate) return [];
    await this.k.read.get(aggregate, businessKey, ctx);
    const instances = await this.k.app.selectFrom('flow.approval_instance').select(['id', 'status', 'steps', 'current_step', 'created_at', 'updated_at'])
      .where('tenant_id', '=', ctx.tenantId).where('process', '=', this.route.process).where('business_key', '=', businessKey).orderBy('created_at', 'desc').limit(50).execute();
    const result = [];
    for (const instance of instances) {
      const steps = await this.k.app.selectFrom('flow.approval_step').select(['step', 'kind', 'status', 'decision', 'decision_visibility', 'actor', 'created_at', 'updated_at', 'due_at'])
        .where('instance_id', '=', instance.id).orderBy('step').execute();
      result.push({ id: instance.id, process: this.route.process, status: instance.status, currentStep: instance.current_step,
        currentSteps: steps.filter(s => (ACTIVE_STEP_STATUSES as readonly string[]).includes(s.status)).map(s => s.step),
        definitionVersion: (instance.steps as ExecutableStep[])[0]?.execution?.definitionVersion ?? null,
        createdAt: new Date(instance.created_at).toISOString(), updatedAt: new Date(instance.updated_at).toISOString(),
        steps: steps.map(s => {
          // 生成的理由也可能包含关联查询或敏感明文，不能只按单据可见就向低权限读者披露。
          const visibility = s.decision_visibility;
          const allowed = !visibility || (visibility.unmask.every((kind: string) => ctx.unmask.includes(kind)) && visibility.queries.every((q: any) =>
            ctx.capabilities.has(`${q.aggregate}.read`) && (grantsFor(ctx, q.aggregate).some(g => g.combinator === 'all') ||
              (visibility.userId === ctx.userId && stableStringify(grantsFor(ctx, q.aggregate)) === stableStringify(q.scopes)))));
          // 只取标题，不把包含提示词/选人政策的完整步骤快照暴露给单据读者。
          const snapshot = (instance.steps as ExecutableStep[])[s.step];
          return { index: s.step, title: snapshot.title, branchPath: snapshot.execution?.branchPath ?? [], dependsOn: [...dependencies(instance.steps, s.step)], kind: s.kind, status: s.status, decision: allowed ? s.decision : null, detailRestricted: !allowed, actor: s.actor, updatedAt: new Date(s.updated_at).toISOString(), dueAt: s.due_at == null ? null : new Date(s.due_at).toISOString() };
        }) });
    }
    return result;
  }

  /**
   * 按业务对象当前 read/范围读取本流程的人工操作记录，跨轮次以递增 ID 游标分页。
   * after 是服务端返回的十进制字符串，避免 bigint 转为 JS number 丢失精度；默认 50、最多 200 条。
   * 历史意见仅供同一对象的授权读者共享，不返回任务变量或 AI 提示词；旧迁移前的动作不会伪造补录。
   */
  async taskHistory(aggregate: string, businessKey: string, ctx: Ctx, options: { after?: string; limit?: number } = {}) {
    const binding = this.k.registry.approvalByProcess(this.route.process)?.a;
    if (binding?.agg.name !== aggregate) throw cageError('NOT_FOUND');
    await this.k.read.get(aggregate, businessKey, ctx);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (options.after !== undefined && (!/^(0|[1-9]\d{0,18})$/.test(options.after) || BigInt(options.after) > 9223372036854775807n))) throw cageError('INVALID_INPUT');
    const rows = await this.k.app.selectFrom('flow.approval_task_action as a')
      .innerJoin('flow.approval_instance as i', 'i.id', 'a.instance_id')
      .select(['a.id', 'a.instance_id', 'a.task_id', 'a.actor_id', 'a.action', 'a.reason', 'a.details', 'a.created_at'])
      .where('a.tenant_id', '=', ctx.tenantId).where('i.tenant_id', '=', ctx.tenantId)
      .where('i.process', '=', this.route.process).where('i.aggregate', '=', aggregate).where('i.business_key', '=', businessKey)
      .where('a.id', '>', options.after ?? '0').orderBy('a.id').limit(limit + 1).execute();
    const items = rows.slice(0, limit).map(r => ({ id: String(r.id), instanceId: r.instance_id, taskId: r.task_id,
      actorId: r.actor_id, action: r.action, reason: r.reason, details: r.details, createdAt: new Date(r.created_at).toISOString() }));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  /** 审批人做出决定；流程结束时在同一事务里执行结论命令 */
  async decide(taskId: string, userId: string, tenantId: string, outcome: 'approved' | 'rejected' | 'returned', comment?: string, expectedRevision?: number): Promise<{ finished: boolean; outcome?: string }> {
    return this.k.app.transaction().execute(tx => this.decideIn(tx, taskId, userId, tenantId, outcome, comment, expectedRevision));
  }

  /** AI 助理的动作回执可与人工待办决定共用该事务，重试不重复审批。 */
  /**
   * 先按租户/受托人定位任务，再锁实例和任务并实时验证能力/单据可见性；过期待办不允许再次决定。
   * 委派未归还或 waiting 时拒绝决定；候选/启用流转的节点要求 revision，避免责任或阶段变化后旧决定仍生效。
   * 驳回/退回直接结束；all 等待全部，any 等任一原票及全部追加票；批准后激活已满足依赖的前后签。
   * 外层拥有事务提交权，可与 AI 助理动作回执共同提交；finished:false 仅表示流程还需后续步骤。
   */
  async decideIn(tx: Transaction<any>, taskId: string, userId: string, tenantId: string, outcome: 'approved' | 'rejected' | 'returned', comment?: string, expectedRevision?: number): Promise<{ finished: boolean; outcome?: string }> {
      if (!['approved', 'rejected', 'returned'].includes(outcome) || (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000))) throw cageError('INVALID_INPUT');
      const { inst, task } = await lockOwnedTask(this.k, tx, this.route.process, taskId, userId, tenantId);
      const s = (inst.steps as ApprovalStep[])[task.step];
      const requiresRevision = s.kind !== 'ai' && (s.assignment === 'candidate' || Object.values(s.actions ?? {}).some(Boolean));
      if ((requiresRevision && expectedRevision === undefined) || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) throw cageError('INVALID_INPUT');
      if (expectedRevision !== undefined && task.revision !== expectedRevision) throw cageError('CONFLICT');
      if (task.delegation === 'pending') throw cageError('INVALID_TRANSITION', { reason: '受托任务必须先归还原审批人' });
      await authorizedTaskActor(this.k, tx, inst, userId, outcome);
      await tx.updateTable('flow.approval_task').set({ status: outcome, comment: comment ?? null, decided_at: sql`now()`, revision: task.revision + 1 }).where('id', '=', taskId).execute();
      await recordTaskAction(tx, inst, taskId, userId, outcome, comment ?? null, { revision: task.revision + 1 });
      if (outcome !== 'approved') return this.finish(tx, inst, task.step, outcome, userId);
      if ((s.kind === 'ai' || s.mode === 'any') && task.task_kind === 'original') {
        // 原审批或签胜出只关闭原候选，不能顺带跳过追加的必签责任。
        const skipped = await tx.updateTable('flow.approval_task').set({ status: 'skipped', revision: sql`revision + 1` })
          .where('instance_id', '=', inst.id).where('step', '=', task.step).where('status', 'in', ['pending', 'waiting']).where('task_kind', '=', 'original').returning('id').execute();
        if (skipped.length) await recordTaskAction(tx, inst, taskId, userId, 'skipped', null, { taskIds: skipped.map(t => t.id), cause: 'any_approved' });
      }
      await activateSignatures(tx, inst, task, s.kind === 'ai' || s.mode === 'any', userId);
      const left = await tx.selectFrom('flow.approval_task').select('id')
        .where('instance_id', '=', inst.id).where('step', '=', task.step).where('status', 'in', ['pending', 'waiting']).executeTakeFirst();
      if (left) return { finished: false };
      return this.advance(tx, inst, task.step, userId);
  }

  /** 先执行带版本的领域结论命令，成功后才关闭剩余待办并写流程终态，保证两边不会各自成功。 */
  private async finish(tx: Transaction<any>, inst: any, stepIndex: number, result: 'approved' | 'rejected' | 'returned', userId?: string) {
    await applyOutcome(this.k, { process: inst.process, tenantId: inst.tenant_id, businessKey: inst.business_key, outcome: result,
      lastApprover: userId, expectedVersion: inst.subject_version ?? undefined }, tx);
    const skipped = await tx.updateTable('flow.approval_task').set({ status: 'skipped', revision: sql`revision + 1` })
      .where('instance_id', '=', inst.id).where('status', 'in', ['pending', 'waiting']).returning('id').execute();
    if (skipped.length) await recordTaskAction(tx, inst, null, userId ?? null, 'skipped', null, { taskIds: skipped.map(t => t.id), cause: result });
    await tx.updateTable('flow.approval_step').set({ status: result, next_notice_scan_at: null, updated_at: sql`now()` }).where('instance_id', '=', inst.id).where('step', '=', stepIndex).execute();
    // 终止传播到其余活跃分支（包括 AI），已批准节点仍保留原结论；迟到的任务/AI 回执由实例终态拒绝。
    await tx.updateTable('flow.approval_step').set({ status: 'skipped', next_notice_scan_at: null, updated_at: sql`now()` })
      .where('instance_id', '=', inst.id).where('step', '!=', stepIndex).where('status', 'in', [...ACTIVE_STEP_STATUSES]).execute();
    await tx.updateTable('flow.approval_instance').set({ status: result, last_approver: userId ?? null,
      last_actor: JSON.stringify(userId ? { kind: 'user', id: userId } : { kind: 'process', id: inst.process }), updated_at: sql`now()` }).where('id', '=', inst.id).execute();
    return { finished: true, outcome: result };
  }

  /**
   * 在实例锁内完成一项节点，再开启所有前驱已通过且尚无持久记录的节点；AND 汇合等待每条分支末端。
   * 创建节点和最终领域结论都在当前事务内，失败回滚本次签署；重启只依赖数据库状态，唯一键阻止重复节点。
   * current_step 仅保留最小活跃索引给旧读者，决定、AI 与提醒均以节点自身状态为准。
   */
  private async advance(tx: Transaction<any>, inst: any, stepIndex: number, userId?: string) {
    await tx.updateTable('flow.approval_step').set({ status: 'approved', next_notice_scan_at: null, updated_at: sql`now()` }).where('instance_id', '=', inst.id).where('step', '=', stepIndex).execute();
    const steps: ExecutableStep[] = inst.steps;
    const rows = await tx.selectFrom('flow.approval_step').select(['step', 'status']).where('instance_id', '=', inst.id).execute();
    const statuses = new Map<number, string>(rows.map(row => [row.step, row.status]));
    if (steps.every((_step, index) => statuses.get(index) === 'approved')) return this.finish(tx, inst, stepIndex, 'approved', userId);
    const opened: number[] = [];
    for (let index = 0; index < steps.length; index++) {
      if (statuses.has(index) || !dependencies(steps, index).every(previous => statuses.get(previous) === 'approved')) continue;
      await this.openStep(tx, inst.id, inst.tenant_id, steps, index, inst.vars, inst.subject_version ?? undefined);
      statuses.set(index, steps[index].kind === 'ai' ? 'queued' : 'running');
      opened.push(index);
    }
    const active = [...statuses].filter(([, status]) => (ACTIVE_STEP_STATUSES as readonly string[]).includes(status)).map(([index]) => index).sort((a, b) => a - b);
    if (!active.length) throw cageError('INVALID_TRANSITION', { reason: '审批执行计划没有可继续的节点' });
    await tx.updateTable('flow.approval_instance').set({ current_step: active[0], last_approver: userId ?? null, updated_at: sql`now()` }).where('id', '=', inst.id).execute();
    if (steps.some(node => node.execution?.branchPath.length)) await recordTaskAction(tx, inst, null, userId ?? null, 'advanced', null,
      { completedStep: stepIndex, openedSteps: opened, currentSteps: active });
    return { finished: false };
  }

  /** 只有仍然占据该节点的 run 能提交；调用方需在同一事务核验 AI run 租约。 */
  /**
   * 锁定实例、节点和业务对象，校验 run 仍占据当前节点且对象版本未变；旧轮次/旧 run 回执一律冲突。
   * 保存判定时同时保存敏感明文/查询范围证据，history 据此决定后来读者能否查看理由。
   * manual 仅开人工接管待办；return/ pass 分别进入共同 finish/advance，保持领域命令约束不变。
   */
  async completeAi(tx: Transaction<any>, stepId: string, runId: string, decision: AiDecision, actor?: Ctx) {
    const ref = await tx.selectFrom('flow.approval_step').select('instance_id').where('id', '=', stepId).executeTakeFirstOrThrow();
    const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', ref.instance_id).where('process', '=', this.route.process).forUpdate().executeTakeFirstOrThrow();
    const current = await tx.selectFrom('flow.approval_step').selectAll().where('id', '=', stepId).forUpdate().executeTakeFirstOrThrow();
    if (inst.status !== 'running' || current.run_id !== runId || !['running', 'queued'].includes(current.status)) throw cageError('CONFLICT');
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
    if (decision.decision === 'return') return this.finish(tx, inst, current.step, 'returned');
    return this.advance(tx, inst, current.step);
  }
}
