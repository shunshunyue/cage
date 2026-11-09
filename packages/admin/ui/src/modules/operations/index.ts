/**
 * 异步运维与第三方同步记录模块的公开入口。
 * 应用壳通过这里组合页面，其他模块无需依赖内部表单实现；导出本身不发请求或执行管理操作。
 */
export { renderOperations } from './operations-page.js';
export { renderSync } from './sync-page.js';
