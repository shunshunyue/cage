// 单一导出入口：CLI 抽取器、API 和 worker 都加载同一套声明。
export * from '@yss123/cage-admin/domain';
export * from './modules/inventory/index.js';
export * from './modules/purchase/index.js';
export * from './workflows/purchase-inventory.js';
export * from './workflows/purchase-process.js';
export * from './integrations/erp.js';
export * from './integrations/intelligence.js';
