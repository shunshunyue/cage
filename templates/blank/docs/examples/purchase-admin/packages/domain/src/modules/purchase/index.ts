// 采购模块的公开声明；其他模块通过本入口依赖它，不穿透内部文件。
// index 只转导出，避免在组装入口里隐藏业务行为或产生初始化副作用。
// 主对象、协作名录、审批、只读统计和定时任务统一由此公开；测试文件不导出，运行时不注册测试夹具。
export * from './purchase-order.js';
export * from './approval-members.js';
export * from './approvals.js';
export * from './queries.js';
export * from './jobs.js';
