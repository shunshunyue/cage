// 路由只决定由谁审批；最终结论仍调用领域命令，执行职责分离和额度约束。
import { approval } from '@yss123/cage-kernel';
import { approver, gt, route, step, when } from '@yss123/cage-approval';
import { PurchaseOrder, OrderSubmitted, OrderCancelled, approve, reject, returnForChanges } from './purchase-order.js';

export const poApproval = approval(PurchaseOrder, {
  process: 'po-approval',
  start: OrderSubmitted,
  cancelOn: [OrderCancelled],
  routable: ['amount', 'deptId'],
  onApproved: approve,
  onRejected: reject,
  onReturned: returnForChanges,
  automatedBy: 'purchase_ai_reviewer',
});

export const poRoute = route('po-approval', [
  step('AI 材料预审', {
    kind: 'ai', model: 'main',
    instructions: '你是采购材料预审员。只检查当前 subject 中的采购用途、金额和物料。用途为空、去除空白后少于 15 个字符或未交代具体用途时，return 退回修改并给出明确建议。涉及紧急采购、单一来源、指定供应商或无法可靠判断的材料，manual 转人工；其它材料清楚且金额为正、物料数量为正时 pass。pass 仅通过本节点，后续经理和财务仍按流程审批。不要猜测不存在的历史价格或附件内容。裁决引用 subject 中实际读取到的字段。',
    context: { fields: ['reason', 'amount', 'items'] },
    handoff: approver.deptLeader('deptId'),
    limits: { maxSteps: 4, maxToolCalls: 5, timeoutMs: 120_000 },
    onFailure: 'manual',
  }),
  step('部门经理审批', approver.deptLeader('deptId')),
  when(gt('amount', 50000), step('财务审批', approver.role('finance'), { mode: 'any' })),
]);
