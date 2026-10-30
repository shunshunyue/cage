// createServer：安全基线默认开启（安全响应头、CSRF、限流、请求体大小、日志打码），业务项目不需要记得加。
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import * as adminDomain from '@yss123/cage-admin/domain';
import { adminRoutes, bootstrapOrg } from '@yss123/cage-admin';
import { approvalRoutes, type InCodeEngine } from '@yss123/cage-approval';
import { createKernel, toCageError, urlsFromEnv, type DatabaseUrls, type Kernel } from '@yss123/cage-kernel';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes, csrfRoute, registerAuthHook, Sessions, type AuthOptions } from './auth.js';
import { CtxCache } from './ctx.js';
import { buildLogger } from './logger.js';
import { oidcRoutes } from './oidc.js';
import { buildOpenApi } from './openapi.js';
import { registerRoutes } from './routes.js';

export interface ServerOptions {
  /** domain 包的导出：import * as domain from '@app/domain' */
  domain: object;
  urls?: DatabaseUrls;
  auth?: AuthOptions & { oidcIssuer?: string };
  /** 业务前端构建产物目录（单页应用），不传时不托管 */
  webDir?: string;
  /** /admin 系统管理，默认开启 */
  admin?: boolean;
  /** 首次启动时初始化组织并打印初始管理员账号，默认开启 */
  bootstrap?: boolean;
  port?: number;
  host?: string;
  /** 默认每个客户端每分钟 300 次 */
  rateLimitPerMinute?: number;
  /** 登录类接口每个客户端每分钟次数，默认 10 */
  authRateLimitPerMinute?: number;
  /** 关闭 CSRF（只用于测试） */
  csrf?: boolean;
  logger?: boolean;
  title?: string;
}

export interface CageServer {
  app: FastifyInstance;
  kernel: Kernel;
  ready(): Promise<FastifyInstance>;
  listen(opts?: { port?: number; host?: string }): Promise<string>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

function adminUiDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve('@yss123/cage-admin/package.json');
    const dir = join(dirname(pkg), 'ui');
    return existsSync(dir) ? dir : null;
  } catch {
    const dir = resolve(here, '../../admin/ui');
    return existsSync(dir) ? dir : null;
  }
}

export function createServer(opts: ServerOptions): CageServer {
  const urls = opts.urls ?? urlsFromEnv();
  const app = Fastify({
    bodyLimit: 1_048_576, // 请求体最大 1 MB
    trustProxy: true, // 在负载均衡后面取真实客户端 IP
    logger: false,
    genReqId: () => crypto.randomUUID(),
  });
  // 组织模型永远在注册表里（同一对象重复导出会自动去重）
  const kernel = createKernel({ domain: [adminDomain, opts.domain], urls, logger: undefined });
  if (opts.logger !== false) {
    const pino = Fastify({ logger: buildLogger(kernel.registry) as any }).log;
    (kernel as any).log = pino;
    (app as any).log = pino;
  }
  const cache = new CtxCache(kernel);
  const authOpts: AuthOptions = {
    ...opts.auth,
    oidc: opts.auth?.oidc ?? (opts.auth?.oidcIssuer && process.env.OIDC_CLIENT_ID
      ? {
          issuer: opts.auth.oidcIssuer,
          clientId: process.env.OIDC_CLIENT_ID!,
          clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
          redirectUri: process.env.OIDC_REDIRECT_URI ?? 'http://localhost:3000/auth/callback',
        }
      : undefined),
  };
  const sessions = new Sessions(kernel, authOpts.sessionHours ?? 8);

  const build = async () => {
    // 原始请求体：入站回调验签要用
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body as string;
      if (!body) return done(null, {});
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(Object.assign(new Error('请求体不是合法的 JSON'), { statusCode: 400 }), undefined);
      }
    });
    await app.register(helmet, {
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'] } },
    });
    await app.register(rateLimit, { max: opts.rateLimitPerMinute ?? 300, timeWindow: '1 minute' });
    await app.register(cookie, { secret: process.env.CAGE_COOKIE_SECRET ?? 'cage-dev-cookie-secret-change-me' });
    await app.register(csrf, { sessionPlugin: '@fastify/cookie', cookieOpts: { signed: true, httpOnly: true, sameSite: 'lax', path: '/' } });
    registerAuthHook(app, kernel, sessions, cache);
    if (opts.csrf !== false) {
      app.addHook('preHandler', (req, reply, done) => {
        // 基于 cookie 会话：所有写请求都要带 CSRF 令牌；第三方回调走签名验证
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.url.startsWith('/hooks/')) return done();
        app.csrfProtection(req, reply, done);
      });
    }
    app.setErrorHandler((err, req, reply) => {
      const e = toCageError(err);
      if (e.code === 'INTERNAL') kernel.log.error({ err, requestId: req.id, url: req.url }, '请求异常');
      reply.status(e.http).send({ code: e.code, ...(e.domainCode ? { domainCode: e.domainCode } : {}), detail: e.code === 'INTERNAL' ? undefined : e.detail, requestId: req.id });
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/hooks/') || req.url.startsWith('/auth/')) {
        return reply.status(404).send({ code: 'NOT_FOUND' });
      }
      if (opts.webDir && existsSync(join(opts.webDir, 'index.html'))) return reply.sendFile('index.html', opts.webDir);
      return reply.status(404).send({ code: 'NOT_FOUND' });
    });

    // 登录相关接口单独一组，限流更严（防暴力破解）
    await app.register(async (auth) => {
      await auth.register(rateLimit, { max: opts.authRateLimitPerMinute ?? 10, timeWindow: '1 minute' });
      authRoutes(auth, kernel, sessions, authOpts);
      oidcRoutes(auth, kernel, sessions, authOpts);
    });
    csrfRoute(app);
    app.get('/healthz', async () => ({ ok: true }));
    const routes = registerRoutes(app, kernel);
    app.get('/api/openapi.json', async () => buildOpenApi(kernel, routes, { title: opts.title }));
    if (opts.admin !== false) adminRoutes(app, kernel);
    const engines = kernel.registry.extensions.filter((e) => e.kind === 'ROUTE').map((e) => e.value.engine(kernel) as InCodeEngine);
    if (engines.length) approvalRoutes(app, { kernel, engines, ctxOf: (req) => req.cageCtx });

    const ui = opts.admin !== false ? adminUiDir() : null;
    if (ui) {
      await app.register(fastifyStatic, { root: ui, prefix: '/admin/', decorateReply: !opts.webDir });
      app.get('/admin', (_req, reply) => reply.redirect('/admin/'));
    }
    if (opts.webDir && existsSync(opts.webDir)) {
      await app.register(fastifyStatic, { root: opts.webDir, prefix: '/', decorateReply: true, wildcard: false });
    }
    await cache.listen(urls.app);
    if (opts.bootstrap !== false) {
      const b = await bootstrapOrg(kernel).catch((e) => {
        kernel.log.warn({ err: String(e) }, '组织初始化失败（是否已执行 cage migrate？）');
        return { created: false } as const;
      });
      if (b.created) {
        // 初始管理员账号只在终端里打印一次
        console.log(`\n  初始管理员  用户名 ${b.username}  密码 ${b.password}\n  请登录 /admin 后立即修改密码\n`);
      }
    }
    await app.ready();
    return app;
  };

  let readyP: Promise<FastifyInstance> | null = null;
  const ready = () => (readyP ??= build());

  return {
    app,
    kernel,
    ready,
    async listen(l = {}) {
      await ready();
      const port = l.port ?? opts.port ?? Number(process.env.PORT ?? 3000);
      const host = l.host ?? opts.host ?? process.env.HOST ?? '0.0.0.0';
      const addr = await app.listen({ port, host });
      kernel.log.info({ addr }, 'api 已启动');
      return addr;
    },
    async close() {
      await app.close();
      await cache.close();
      await kernel.close();
    },
  };
}
