// @yss123/cage-http：Fastify 插件、路由生成、认证、安全基线。
export { createServer, type ServerOptions, type CageServer } from './server.js';
export { registerRoutes, routeTable, commandUrl, type RouteInfo } from './routes.js';
export { buildOpenApi } from './openapi.js';
export { buildLogger, sensitiveFieldPaths } from './logger.js';
export { CtxCache } from './ctx.js';
export { Sessions, verifyPassword, SESSION_COOKIE, type AuthOptions } from './auth.js';
export { upsertUserFromSso } from './oidc.js';
