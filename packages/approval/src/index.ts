// @yss123/cage-approval（可选）：审批适配接口、桥接与代码内封闭路由。
export * from './types.js';
export { applyOutcome, bindApproval } from './bridge.js';
export {
  route, step, when, approver, gt, gte, lt, lte, eq, ne, isIn, evalCondition, resolveSteps, FLOW_DDL,
  type Route, type RouteNode, type Step, type When, type Approver, type Condition,
} from './route.js';
export { InCodeEngine, type TaskView } from './engine.js';
export { approvalRoutes } from './http.js';
