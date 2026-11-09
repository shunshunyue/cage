// 单一导出入口：CLI 抽取器、API 和 worker 都加载同一套声明。
// 新增声明必须沿模块入口导出到这里，才能参与注册、生成、图规则和后台消费者发现。
// 此处只组合组织模型、业务模块与跨模块集成，不运行初始化、迁移、造数或网络请求。
export * from '@yss123/cage-admin/domain';
export * from './modules/inventory/index.js';
export * from './modules/purchase/index.js';
export * from './workflows/purchase-inventory.js';
export * from './workflows/purchase-process.js';
export * from './integrations/erp.js';
export * from './integrations/intelligence.js';
