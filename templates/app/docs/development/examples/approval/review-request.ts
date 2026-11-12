/**
 * 审批课程的部门申请：用户创建和提交，worker 启动待办，审批引擎再以 process 命令保存结论。
 * 聚合、事件、绑定和路由在同一教学文件展示，应用使用时放入领域模块并从 domain 入口导出。
 * 文件仅声明业务规格，不自动运行、初始化人员或授予权限；本课不包含修订重提和外部系统。
 */
import { aggregate, approval, command, emit, event, id, ref, scope, sod, states, text } from '@yss123/cage-kernel';
import { approver, route, step } from '@yss123/cage-approval';
import { z } from 'zod';

/** 部门申请保存说明及归属；终态保留历史，批准人与申请人的职责分离由结论命令检查。 */
export const ReviewRequest = aggregate('ReviewRequest', {
  description: '部门申请',
  fields: {
    /** 申请说明最多 1000 字符，创建输入还会 trim 并拒绝空白。 */
    reason: text(1000).describe('申请说明'),
    /** 缺省取当前用户部门；范围校验和负责人选人都使用这个实际部门。 */
    deptId: ref('Dept').describe('所属部门'),
    /** 创建人由内核设置，作为本人范围及不可自审批的依据。 */
    createdBy: ref('User').describe('申请人'),
  },
  states: states('draft', 'pending', 'approved', 'rejected', 'cancelled', {
    terminal: ['approved', 'rejected', 'cancelled'],
    labels: { draft: '草稿', pending: '待审批', approved: '已批准', rejected: '已驳回', cancelled: '已撤回' },
  }),
  scope: scope.deptSubtree('deptId'),
});

/** 提交后的事实；申请标识由 emit 显式映射，流程选人另取 routable 的部门快照。 */
export const ReviewRequestSubmitted = event('ReviewRequestSubmitted', {
  requestId: id().describe('申请标识'),
}, { description: '部门申请已提交' });

/** 撤回事实触发审批取消，已有意见历史保留；事件声明本身不直接操作待办表。 */
export const ReviewRequestWithdrawn = event('ReviewRequestWithdrawn', {
  requestId: id().describe('申请标识'),
}, { description: '部门申请已撤回' });

/** 创建草稿；只接收申请说明，内核维护身份、归属、版本和成功审计。 */
export const createReviewRequest = command(ReviewRequest, {
  name: 'create', description: '创建部门申请', from: 'new', to: 'draft',
  input: z.object({ reason: z.string().trim().min(1).max(1000) }),
  handler: draft => draft,
});

/** 提交后进入待审批并写入事件；待办由 worker 后续创建，返回成功只证明提交事务完成。 */
export const submitReviewRequest = command(ReviewRequest, {
  name: 'submit', description: '提交部门申请', from: 'draft', to: 'pending',
  emits: [emit(ReviewRequestSubmitted, request => ({ requestId: request.id }))],
  handler: draft => draft,
});

/** 将待审批申请撤回到终态，worker 消费事件取消旧待办；本课不提供撤回后的重提命令。 */
export const withdrawReviewRequest = command(ReviewRequest, {
  name: 'withdraw', description: '撤回部门申请', from: 'pending', to: 'cancelled',
  emits: [emit(ReviewRequestWithdrawn, request => ({ requestId: request.id }))],
  handler: draft => draft,
});

/** 批准只供流程调用；真人需批准能力、读取范围并通过职责分离，失败使本次决定事务回滚。 */
export const approveReviewRequest = command(ReviewRequest, {
  name: 'approve', description: '批准部门申请', from: 'pending', to: 'approved',
  invokedBy: 'process', constraints: [sod.notSameAs('createdBy')],
  handler: draft => draft,
});

/** 驳回沿用相同的身份、权限与状态守卫，最终状态由内核设置，不直接更新业务表。 */
export const rejectReviewRequest = command(ReviewRequest, {
  name: 'reject', description: '驳回部门申请', from: 'pending', to: 'rejected',
  invokedBy: 'process', constraints: [sod.notSameAs('createdBy')],
  handler: draft => draft,
});

/** 绑定领域事件与本聚合结论，只开放选人需要的部门字段；process 与 route 必须一致。 */
export const requestApproval = approval(ReviewRequest, {
  process: 'department-request', start: ReviewRequestSubmitted, cancelOn: [ReviewRequestWithdrawn],
  routable: ['deptId'], onApproved: approveReviewRequest, onRejected: rejectReviewRequest,
});

/** 一个部门负责人节点；负责人来自真实组织数据，声明不创建人员，也不授予业务能力。 */
export const requestRoute = route('department-request', [
  step('部门负责人审批', approver.deptLeader('deptId')),
]);
