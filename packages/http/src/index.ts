// @yss123/cage-http：Fastify 插件、路由生成、认证、安全基线。
/** 应用 API 启动的公共入口。createServer 组合组织模型、安全插件、声明路由与运行时扩展，
 * 并返回显式 ready/listen/close 生命周期；导入本模块本身不会监听端口或执行数据库迁移。
 * 低层认证和日志导出用于受控集成，不能绕过命令内核的业务授权；worker 入口单独从子路径使用。
 */
export { createServer, type ServerOptions, type CageServer, type ServerHealth } from './server.js';
export { registerRoutes, routeTable, commandUrl, type RouteInfo } from './routes.js';
export { buildOpenApi } from './openapi.js';
export { buildLogger, sensitiveFieldPaths, createLogSanitizer, createSafeLogger } from './logger.js';
export { CtxCache } from './ctx.js';
export { Sessions, PasswordVerifier, verifyPassword, SESSION_COOKIE, type AuthOptions } from './auth.js';
export { upsertUserFromSso } from './oidc.js';
export { FileService, LocalFileStorage, type FileServiceOptions, type FileStorage } from '@yss123/cage-files';
