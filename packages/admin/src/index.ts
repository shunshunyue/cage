/**
 * 系统管理包的服务端公共入口。
 * 组织声明可被业务 domain 注册；初始化、管理接口和展示目录供 API 装配层调用。
 * 浏览器不能从此处导入服务端实现，应使用生成契约或管理页面自己的 HTTP 展示模型。
 */
// @yss123/cage-admin：组织模型声明、初始化、/admin 系统管理（接口与前端页面）。
export * from './domain/index.js';
export { noEscalation, noEscalationViaRoles, noWiderScope, knownCapability } from './domain/constraints.js';
export { hashPassword } from './domain/org.js';
export { bootstrapOrg, grantAll, grantAllToSuperadmin, type BootstrapResult } from './bootstrap.js';
export { adminRoutes } from './http.js';
export { adminCatalog, type AdminLabels } from './catalog.js';
