// 单一导出入口：CLI 抽取器、API 和 worker 都加载同一套声明。
export * from '@yss123/cage-admin/domain';
export * from './inventory.js';
export * from './purchase-order.js';
export * from './reactions.js';
export * from './approvals.js';
export * from './erp.js';
export * from './queries.js';
export * from './jobs.js';
