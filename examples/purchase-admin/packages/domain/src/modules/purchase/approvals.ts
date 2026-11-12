/**
 * 采购实际审批路由：AI 预审、部门审核、可选专业会签和大额财务候选受理，共用一个采购流程实例。
 * 人工节点显式开放转办、委派和前后/并行加签；步骤/政策随提交保存，旧实例保持自己的快照。
 * 路由只决定任务分配与签序，最终结论仍执行领域命令的职责分离与库存约束。
 */
import { approval } from '@yss123/cage-kernel';
import { approver, eq, gt, route, step, when } from '@yss123/cage-approval';
import { PurchaseOrder, OrderSubmitted, OrderCancelled, approve, reject, returnForChanges } from './purchase-order.js';

/**
 * 把提交/取消事件与审批生命周期关联；routable 仅开放金额、部门和专业复核需求/名单。
 * 通过、驳回、退回分别调用已有 process 命令，领域状态与最终审批结论由引擎在事务内落实。
 * automatedBy 是自动结论执行角色代码，必须由部署管理员显式配置能力和范围，声明不自动授予权限。
 */
export const poApproval = approval(PurchaseOrder, {
  process: 'po-approval',
  start: OrderSubmitted,
  cancelOn: [OrderCancelled],
  routable: ['amount', 'deptId', 'needsSpecialistReview', 'reviewerIds'],
  onApproved: approve,
  onRejected: reject,
  onReturned: returnForChanges,
  automatedBy: 'purchase_ai_reviewer',
});

/**
 * 顺序为 AI 材料预审、部门经理、按单据指定人员的专业会签、条件财务候选受理。
 * needsSpecialistReview=true 才增加专业会签，名单来自提交快照且全部人必须通过；金额严格大于 50000 元才增加财务节点。
 * AI 只读取 reason/amount/items，pass 仅推进到经理，return 回到草稿，manual 在当前节点交部门负责人。
 * 模型失败同样转人工，最多四轮/五次工具调用/120 秒；不以失败兜底为自动批准。
 * 财务共享一项未分配任务，finance 当前成员须先领取；所有人工动作仍需真实命令能力、范围和职责分离。
 * AI 人工接管保持原节点规则；经理、专业和财务才开放三项管理动作，新实例自动保存允许的加签位置。
 */
export const poRoute = route('po-approval', [
  step('AI 材料预审', {
    kind: 'ai', model: 'main',
    instructions: '你是采购材料预审员。只检查当前 subject 中的采购用途、金额和物料。用途为空、去除空白后少于 15 个字符或未交代具体用途时，return 退回修改并给出明确建议。涉及紧急采购、单一来源、指定供应商或无法可靠判断的材料，manual 转人工；其它材料清楚且金额为正、物料数量为正时 pass。pass 仅通过本节点，后续经理和财务仍按流程审批。不要猜测不存在的历史价格或附件内容。裁决引用 subject 中实际读取到的字段。',
    context: { fields: ['reason', 'amount', 'items'] },
    handoff: approver.deptLeader('deptId'),
    limits: { maxSteps: 4, maxToolCalls: 5, timeoutMs: 120_000 },
    onFailure: 'manual',
  }),
  step('部门经理审批', approver.deptLeader('deptId'), { actions: { transfer: true, delegate: true, addSign: true } }),
  when(eq('needsSpecialistReview', true), step('专业人员会签', approver.field('reviewerIds'), {
    mode: 'all', actions: { transfer: true, delegate: true, addSign: true },
  })),
  when(gt('amount', 50000), step('财务候选受理', approver.role('finance'), {
    assignment: 'candidate', mode: 'any', actions: { transfer: true, delegate: true, addSign: true },
  })),
]);
