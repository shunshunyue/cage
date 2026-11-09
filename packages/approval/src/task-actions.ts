/**
 * 人工待办的领取/释放、转办、委派归还与前后/并行加签，由 InCodeEngine 和 HTTP 调用。
 * 操作先锁实例再锁任务，重新核验归属、提交版本、权限与节点快照政策；任务修改和不可覆盖的操作记录共同提交。
 * 本模块只维护 flow 数据，不执行最终业务结论；委派不等于批准，加签不创建新的审批节点或授予能力。
 */
import { cageError, loadUserGrants, userCtx, type Kernel, type Ctx } from '@yss123/cage-kernel';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { ApprovalStep } from './route.js';
import { resolveApprovers } from './selectors.js';

/** 人工节点显式开放的任务操作；缺省均关闭，已运行实例使用保存的政策而非最新代码。 */
export interface TaskActionPolicy {
  /** 允许当前审批人将责任转给另一位已有审批权限的用户。 */
  transfer?: boolean;
  /** 允许委派处理后归还原审批人；受托人不能直接作出审批结论。 */
  delegate?: boolean;
  /** 允许原始待办添加当前节点的前签、后签或并行必签人；加签待办本身不能继续加签。 */
  addSign?: boolean;
}

const common = { expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), reason: z.string().trim().min(1).max(1000) };
/** HTTP 与直接引擎调用共用的严格输入协议，拒绝未知字段；revision 是任务版本，不是业务对象版本。 */
export const taskActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('transfer'), ...common, targetUserId: z.uuid() }),
  z.strictObject({ action: z.literal('delegate'), ...common, targetUserId: z.uuid() }),
  z.strictObject({ action: z.literal('resolve'), ...common }),
  z.strictObject({ action: z.literal('claim'), ...common }),
  z.strictObject({ action: z.literal('unclaim'), ...common }),
  z.strictObject({ action: z.literal('addSign'), ...common, userIds: z.array(z.uuid()).min(1).max(20), placement: z.enum(['parallel', 'before', 'after']).optional() }),
]);
/** action 区分领取/释放、转办、委派、归还和加签；placement 缺省并行，reason 必须说明原因，目标 ID 不授予权限。 */
export type TaskActionInput = z.infer<typeof taskActionSchema>;
/** 已提交的任务变更回执；新加签待办各从 revision=0 开始，原任务版本始终递增。 */
export interface TaskActionResult {
  /** 被操作的原任务 ID。 */
  taskId: string;
  /** 变更后的原任务版本，重复提交旧版本会返回冲突而不会再次变更。 */
  revision: number;
  /** 本次加签新建的待办 ID，其他操作为空数组。 */
  createdTaskIds: string[];
}

/**
 * 按租户与当前受托人找到任务，再以实例→任务的固定顺序加锁。
 * 锁后再次核对归属与当前步骤，防止转办和决定竞争时使用锁前的旧身份；找不到或不归本人统一 404。
 * unassigned 仅供领取使用，只接受无人持有的 candidate；候选身份由调用方在同一锁内另查。
 */
export async function lockOwnedTask(k: Kernel, tx: Transaction<any>, process: string, taskId: string, userId: string, tenantId: string, unassigned = false) {
  if (!z.uuid().safeParse(taskId).success) throw cageError('NOT_FOUND');
  const candidate = await tx.selectFrom('flow.approval_task').select('instance_id')
    .where('id', '=', taskId).where('tenant_id', '=', tenantId)
    .$if(!unassigned, query => query.where('assignee', '=', userId))
    .$if(unassigned, query => query.where('assignment', '=', 'candidate').where('assignee', 'is', null)).executeTakeFirst();
  if (!candidate) throw cageError('NOT_FOUND');
  const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', candidate.instance_id)
    .where('tenant_id', '=', tenantId).where('process', '=', process).forUpdate().executeTakeFirst();
  if (!inst) throw cageError('NOT_FOUND');
  const task = await tx.selectFrom('flow.approval_task').selectAll().where('id', '=', taskId).where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
  if (!task || (unassigned ? task.assignment !== 'candidate' || task.assignee !== null : task.assignee !== userId)) throw cageError('NOT_FOUND');
  // 并行分支各自拥有活跃节点，不能用实例兼容摘要 current_step 排除其他分支的合法待办。
  const activeStep = await tx.selectFrom('flow.approval_step').select('status').where('instance_id', '=', inst.id).where('step', '=', task.step).executeTakeFirst();
  if (inst.status !== 'running' || task.status !== 'pending' || !activeStep || !['running', 'waiting_manual'].includes(activeStep.status)) throw cageError('INVALID_TRANSITION');
  const binding = k.registry.approvalByProcess(process)!.a;
  const subject = await tx.selectFrom(`${binding.agg.table.schema}.${binding.agg.table.name}`).select('version')
    .where('id', '=', inst.business_key).where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!subject || (inst.subject_version !== null && subject.version !== inst.subject_version)) throw cageError('CONFLICT', { reason: '审批所针对的业务版本已变化' });
  return { inst, task, binding };
}

/** 选人和决定都实时检查 active 用户、指定结论能力及单据 read/范围；此检查不替代最终命令中的硬约束。 */
export async function authorizedTaskActor(k: Kernel, tx: Transaction<any>, inst: any, userId: string, outcome: 'approved' | 'rejected' | 'returned' = 'approved'): Promise<Ctx> {
  const binding = k.registry.approvalByProcess(inst.process)!.a;
  const command = outcome === 'approved' ? binding.onApproved : outcome === 'rejected' ? binding.onRejected : binding.onReturned;
  // 复用持有实例锁的连接加载授权；若另从 app 池取连接，排队操作占满池时会阻塞锁持有者。
  const grants = await loadUserGrants(tx, userId, inst.tenant_id);
  const actor = grants ? userCtx(grants) : null;
  if (!actor || !command || !actor.capabilities.has(k.registry.capabilityOf(command)) || !actor.capabilities.has(`${binding.agg.name}.read`)) throw cageError('FORBIDDEN');
  // 只查安全视图中的存在性，不读取明文字段或制造不必要的明文读取审计；范围仍由读账号落实。
  const visible = await k.read.tx(actor, read => read.selectFrom(`safe.${binding.agg.table.name}`).select('id').where('id', '=', inst.business_key).executeTakeFirst());
  if (!visible) throw cageError('NOT_FOUND');
  return actor;
}

/**
 * 仅追加审批动作，不覆盖原决定 comment；调用方的事务失败会连同记录一起回滚。
 * 表对应用账号只开放 SELECT/INSERT；reason 是人工意见，调用人不得在其中放凭据或无权共享的内容。
 */
export async function recordTaskAction(tx: Transaction<any>, inst: any, taskId: string | null, actorId: string | null, action: string, reason: string | null, details: Record<string, unknown> = {}) {
  await tx.insertInto('flow.approval_task_action').values({ tenant_id: inst.tenant_id, instance_id: inst.id,
    task_id: taskId, actor_id: actorId, action, reason, details: JSON.stringify(details) }).execute();
}

/**
 * 执行一个任务管理动作；领取/释放由 assignment 声明开放，其余由 actions 开放，AI 接管待办保持原有语义。
 * 目标不得是本人、原委派人或该节点已承担/已完成审批的人，防止会签转办变相减少独立审批人数。
 * 同节点最多追加 20 位必签人；重复网络提交凭旧 revision 拒绝，不提供成功回执缓存或自动重试。
 */
export async function executeTaskAction(k: Kernel, process: string, taskId: string, userId: string, tenantId: string, input: TaskActionInput): Promise<TaskActionResult> {
  const parsed = taskActionSchema.safeParse(input);
  if (!parsed.success) throw cageError('INVALID_INPUT');
  const data = parsed.data;
  return k.app.transaction().execute(async tx => {
    const { inst, task } = await lockOwnedTask(k, tx, process, taskId, userId, tenantId, data.action === 'claim');
    if (task.revision !== data.expectedRevision) throw cageError('CONFLICT');
    await authorizedTaskActor(k, tx, inst, userId);
    const node = (inst.steps as ApprovalStep[])[task.step];
    if (data.action === 'claim' || data.action === 'unclaim') {
      if (node.kind === 'ai' || node.assignment !== 'candidate' || task.assignment !== 'candidate') throw cageError('FORBIDDEN');
      if (task.delegation === 'pending') throw cageError('INVALID_TRANSITION');
      if (data.action === 'claim') {
        if (!(await resolveApprovers(tx, node.approver, inst.vars, tenantId)).includes(userId)) throw cageError('FORBIDDEN');
        // 候选身份不允许一人领取同节点第二票；已完成票和委派 owner 也算已承担责任。
        const peer = await tx.selectFrom('flow.approval_task').select('id').where('instance_id', '=', inst.id).where('step', '=', task.step)
          .where('id', '!=', task.id).where(q => q.or([q('assignee', '=', userId), q('owner_id', '=', userId)])).executeTakeFirst();
        if (peer) throw cageError('CONFLICT', { reason: '领取人已参与当前节点' });
      } else {
        // 不能用释放候选任务绕过已提出的必签责任；完成后可释放，父子关联仍保留。
        const child = await tx.selectFrom('flow.approval_task').select('id').where('parent_task_id', '=', task.id)
          .where('status', 'in', ['pending', 'waiting']).executeTakeFirst();
        if (child) throw cageError('INVALID_TRANSITION', { reason: '存在未完成加签，不能释放任务' });
      }
      const assignee = data.action === 'claim' ? userId : null;
      await tx.updateTable('flow.approval_task').set({ assignee, owner_id: null, delegation: null, revision: task.revision + 1 }).where('id', '=', taskId).execute();
      await tx.updateTable('flow.approval_instance').set({ updated_at: sql`now()` }).where('id', '=', inst.id).execute();
      await recordTaskAction(tx, inst, taskId, userId, data.action, data.reason, { from: task.assignee, to: assignee, revision: task.revision + 1 });
      return { taskId, revision: task.revision + 1, createdTaskIds: [] };
    }
    const permission = data.action === 'resolve' ? 'delegate' : data.action;
    if (node.kind === 'ai' || !node.actions?.[permission]) throw cageError('FORBIDDEN', { reason: '该节点未开放此任务操作' });
    const pendingDelegation = task.delegation === 'pending';
    if ((data.action === 'resolve') !== pendingDelegation) throw cageError('INVALID_TRANSITION');
    const createdTaskIds: string[] = [];
    let assignee = task.assignee, owner = task.owner_id, delegation = task.delegation;
    if (data.action === 'resolve') {
      // 归还只能回到服务端保留的原审批人；停用或撤权后不能假装归还成功。
      await authorizedTaskActor(k, tx, inst, task.owner_id);
      assignee = task.owner_id;
      delegation = 'resolved';
    } else {
      const targets = data.action === 'addSign' ? data.userIds : [data.targetUserId];
      if (new Set(targets).size !== targets.length || targets.includes(userId)) throw cageError('INVALID_INPUT');
      const peers = await tx.selectFrom('flow.approval_task').select(['assignee', 'owner_id', 'task_kind'])
        .where('instance_id', '=', inst.id).where('step', '=', task.step).execute();
      if (targets.some(id => peers.some(p => p.assignee === id || p.owner_id === id))) throw cageError('CONFLICT', { reason: '接收人已参与当前节点' });
      for (const target of targets) await authorizedTaskActor(k, tx, inst, target);
      if (data.action === 'addSign') {
        // 第一批在途快照只有 addSign 布尔值，仍限原来的并行加签；新实例显式保存位置集合。
        if (!(node.signPositions ?? ['parallel']).includes(data.placement ?? 'parallel')) throw cageError('FORBIDDEN', { reason: '该实例未开放此加签位置' });
        if (task.task_kind !== 'original') throw cageError('FORBIDDEN', { reason: '加签待办不能再次加签' });
        if (peers.filter(p => p.task_kind === 'additional').length + targets.length > 20) throw cageError('INVALID_INPUT', { reason: '节点加签总人数最多为 20' });
        for (const target of targets) {
          const added = await tx.insertInto('flow.approval_task').values({ tenant_id: tenantId, instance_id: inst.id,
            step: task.step, title: task.title, assignee: target, task_kind: 'additional', parent_task_id: task.id,
            sign_position: data.placement ?? 'parallel', status: data.placement === 'after' ? 'waiting' : 'pending' }).returning('id').executeTakeFirstOrThrow();
          createdTaskIds.push(added.id);
        }
      } else {
        assignee = data.targetUserId;
        owner = data.action === 'delegate' ? userId : null;
        delegation = data.action === 'delegate' ? 'pending' : null;
      }
    }
    // 前签先挂起父任务，只有全部前签批准才能由引擎唤醒；waiting 任务不能操作或决定。
    await tx.updateTable('flow.approval_task').set({ assignee, owner_id: owner, delegation, revision: task.revision + 1,
      status: data.action === 'addSign' && data.placement === 'before' ? 'waiting' : 'pending' }).where('id', '=', taskId).execute();
    await tx.updateTable('flow.approval_instance').set({ updated_at: sql`now()` }).where('id', '=', inst.id).execute();
    await recordTaskAction(tx, inst, taskId, userId, data.action, data.reason, { from: task.assignee, to: assignee,
      revision: task.revision + 1, ...(data.action === 'addSign' ? { userIds: data.userIds, taskIds: createdTaskIds, placement: data.placement ?? 'parallel' } : {}) });
    return { taskId, revision: task.revision + 1, createdTaskIds };
  });
}

/** 前向迁移：旧待办保持 original/revision=0，既有实例无 actions 因而不会自动开放管理操作。 */
export const APPROVAL_TASK_ACTIONS_MIGRATION = {
  name: 'cage:approval_task_actions_001',
  sql: `
ALTER TABLE flow.approval_task ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE flow.approval_task ADD COLUMN owner_id uuid;
ALTER TABLE flow.approval_task ADD COLUMN delegation text CHECK (delegation IN ('pending','resolved'));
ALTER TABLE flow.approval_task ADD COLUMN task_kind text NOT NULL DEFAULT 'original' CHECK (task_kind IN ('original','additional'));
ALTER TABLE flow.approval_task ADD CONSTRAINT approval_task_delegation_owner CHECK (delegation IS NULL OR owner_id IS NOT NULL);
CREATE TABLE flow.approval_task_action (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES flow.approval_instance(id),
  task_id uuid REFERENCES flow.approval_task(id),
  actor_id uuid,
  action text NOT NULL,
  reason text,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_task_action_instance_idx ON flow.approval_task_action(tenant_id, instance_id, id);
REVOKE ALL ON flow.approval_task_action FROM cage_app;
GRANT SELECT, INSERT ON flow.approval_task_action TO cage_app;
GRANT USAGE, SELECT ON SEQUENCE flow.approval_task_action_id_seq TO cage_app;
`,
};
