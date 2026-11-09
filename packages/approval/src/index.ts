// @yss123/cage-approval（可选）：审批适配接口、桥接与代码内封闭路由。
/**
 * 应用声明路由/绑定，HTTP 装配待办接口，worker 装配启动/取消消费者；三者使用同一流程标识。
 * 结论必须经过桥接命令，不能因为引擎已经判断通过就绕过领域状态、权限、版本或不变量。
 */
export * from './types.js';
export { applyOutcome, bindApproval } from './bridge.js';
export {
  route, step, when, parallel, branch, approver, gt, gte, lt, lte, eq, ne, isIn, evalCondition, resolveSteps, FLOW_DDL,
  type Route, type RouteNode, type Step, type When, type Parallel, type Branch, type Approver, type Condition,
} from './route.js';
export { InCodeEngine, type TaskView } from './engine.js';
export { approvalRoutes } from './http.js';
export { approvalOpenApi } from './openapi.js';
export { approvalRoleContext, type AiStep, type AiStepOptions, type AiDecision } from './ai.js';
export type { ApprovalStep } from './route.js';
export { taskActionSchema, type TaskActionPolicy, type TaskActionInput, type TaskActionResult } from './task-actions.js';
export { approvalOperations, approvalOperationsService, ApprovalOperationsService,
  type ApprovalNoticeView, type ApprovalRequestView, type ApprovalNoticeOptions } from './operations.js';
export type { ApprovalSla, ApprovalReminderPolicy } from './deadlines.js';
