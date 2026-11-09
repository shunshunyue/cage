/**
 * 前后加签的持久阶段与前向迁移，由审批引擎在批准事务内调用。
 * 父子关系保存在任务上，不改写实例步骤或 AI run；实例锁保证激活和决定/取消不会交错提交。
 * 所有追加票都是必签，any 的原票胜出只替代原票责任，不能吞掉已创建的加签。
 */
import { sql, type Transaction } from 'kysely';
import { recordTaskAction } from './task-actions.js';

/**
 * 批准后激活可运行任务并追加系统阶段记录，激活也递增 revision 使旧页面失效。
 * before 全部完成才唤醒仍 waiting 的父票；父票已被 any 跳过则不复活。
 * after 在 all 中等待自己的父票批准，在 any 中等待任意原票批准；追加票自身仍全部必签。
 */
export async function activateSignatures(tx: Transaction<any>, inst: any, task: any, anyMode: boolean, userId: string) {
  const activated: string[] = [];
  if (task.sign_position === 'before') {
    const unfinished = await tx.selectFrom('flow.approval_task').select('id').where('parent_task_id', '=', task.parent_task_id)
      .where('sign_position', '=', 'before').where('status', 'in', ['pending', 'waiting']).executeTakeFirst();
    if (!unfinished) {
      const parent = await tx.updateTable('flow.approval_task').set({ status: 'pending', revision: sql`revision + 1` })
        .where('id', '=', task.parent_task_id).where('instance_id', '=', inst.id).where('status', '=', 'waiting').returning('id').execute();
      activated.push(...parent.map(row => row.id));
    }
  }
  if (task.task_kind === 'original') {
    const children = await tx.updateTable('flow.approval_task').set({ status: 'pending', revision: sql`revision + 1` })
      .where('instance_id', '=', inst.id).where('step', '=', task.step).where('sign_position', '=', 'after').where('status', '=', 'waiting')
      .$if(!anyMode, query => query.where('parent_task_id', '=', task.id)).returning('id').execute();
    activated.push(...children.map(row => row.id));
  }
  if (activated.length) await recordTaskAction(tx, inst, task.id, userId, 'activated', null, { taskIds: activated, cause: 'signature_dependency_approved' });
}

/** 前向升级：旧任务保持 direct、无父任务与签序，旧数据不会被转换为候选池或合并票数。 */
export const APPROVAL_TASK_STAGES_MIGRATION = {
  name: 'cage:approval_task_stages_002',
  sql: `
ALTER TABLE flow.approval_task ALTER COLUMN assignee DROP NOT NULL;
ALTER TABLE flow.approval_task ADD COLUMN assignment text NOT NULL DEFAULT 'direct' CHECK (assignment IN ('direct','candidate'));
ALTER TABLE flow.approval_task ADD COLUMN parent_task_id uuid REFERENCES flow.approval_task(id);
ALTER TABLE flow.approval_task ADD COLUMN sign_position text CHECK (sign_position IN ('parallel','before','after'));
ALTER TABLE flow.approval_task ADD CONSTRAINT approval_task_assignee_required CHECK (assignee IS NOT NULL OR assignment = 'candidate');
ALTER TABLE flow.approval_task ADD CONSTRAINT approval_task_signature_parent CHECK ((parent_task_id IS NULL AND sign_position IS NULL) OR (parent_task_id IS NOT NULL AND sign_position IS NOT NULL AND task_kind = 'additional' AND assignment = 'direct'));
CREATE INDEX approval_task_candidates_idx ON flow.approval_task(tenant_id, created_at DESC) WHERE assignment = 'candidate' AND assignee IS NULL AND status = 'pending';
CREATE INDEX approval_task_parent_idx ON flow.approval_task(parent_task_id) WHERE parent_task_id IS NOT NULL;
`,
};
