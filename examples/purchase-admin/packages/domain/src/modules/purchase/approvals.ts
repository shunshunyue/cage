// 路由只决定由谁审批；最终结论仍调用领域命令，执行职责分离和额度约束。
import { approval } from '@yss123/cage-kernel';
import { approver, gt, route, step, when } from '@yss123/cage-approval';
import { PurchaseOrder, OrderSubmitted, OrderCancelled, approve, reject } from './purchase-order.js';

export const poApproval = approval(PurchaseOrder, {
  process: 'po-approval',
  start: OrderSubmitted,
  cancelOn: [OrderCancelled],
  routable: ['amount', 'deptId'],
  onApproved: approve,
  onRejected: reject,
});

export const poRoute = route('po-approval', [
  step('部门经理审批', approver.deptLeader('deptId')),
  when(gt('amount', 50000), step('财务审批', approver.role('finance'), { mode: 'any' })),
]);
