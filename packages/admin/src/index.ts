// @yss123/cage-admin：组织模型声明、初始化、/admin 系统管理（接口与前端页面）。
export * from './domain/index.js';
export { noEscalation, noEscalationViaRoles, noWiderScope, knownCapability } from './domain/constraints.js';
export { hashPassword } from './domain/org.js';
export { bootstrapOrg, grantAll, grantAllToSuperadmin, type BootstrapResult } from './bootstrap.js';
export { adminRoutes } from './http.js';
export { adminCatalog, type AdminLabels } from './catalog.js';
