// createServer：安全基线默认开启（安全响应头、CSRF、限流、请求体大小、日志打码），业务项目不需要记得加。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import * as adminDomain from '@yss123/cage-admin/domain';
import { adminRoutes } from '@yss123/cage-admin';
import { approvalRoutes, type InCodeEngine } from '@yss123/cage-approval';
import { createKernel, runtimeServices, toCageError, urlsFromEnv, type DatabaseUrls, type Kernel } from '@yss123/cage-kernel';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { sql } from 'kysely';
import { authRoutes, csrfRoute, registerAuthHook, Sessions, type AuthOptions } from './auth.js';
import { CtxCache } from './ctx.js';
import { buildLogger } from './logger.js';
import { oidcRoutes } from './oidc.js';
import { buildOpenApi } from './openapi.js';
import { registerRoutes } from './routes.js';
import { FileService, type FileServiceOptions } from '@yss123/cage-files';
import { registerFiles } from './files.js';

export interface ServerOptions {
  /** 私有文件存储与上传限制；默认本地 .cage-files。 */
  files?: FileServiceOptions;
  /** domain 包的导出：import * as domain from '@app/domain' */
  domain: object;
  urls?: DatabaseUrls;
  auth?: AuthOptions & { oidcIssuer?: string };
  /** 业务前端构建产物目录（单页应用），不传时不托管 */
  webDir?: string;
  /** /admin 系统管理，默认开启 */
  admin?: boolean;
  /** 系统管理显示名，使用 aggregate:/command:/capability: 等图谱键；覆盖本地配置。 */
  adminLabels?: Record<string, string>;
  /** 仅保留 false 的兼容入口。组织初始化请显式调用 bootstrapOrg，不在服务启动时执行。 */
  bootstrap?: boolean;
  /** 默认不信任转发头；反向代理部署应显式配置可信地址、网段或跳数。 */
  trustProxy?: FastifyServerOptions['trustProxy'];
  /** 默认读取 CAGE_COOKIE_SECRET；生产环境必须提供至少 32 字节的独立密钥。 */
  cookieSecret?: string;
  /** 就绪探测的每个数据库等待上限，默认 2000 毫秒。 */
  readinessTimeoutMs?: number;
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
  files: FileService;
  app: FastifyInstance;
  kernel: Kernel;
  ready(): Promise<FastifyInstance>;
  health(): Promise<ServerHealth>;
  listen(opts?: { port?: number; host?: string }): Promise<string>;
  close(): Promise<void>;
}

export interface ServerHealth {
  ok: boolean;
  dependencies: { appDb: boolean; readDb: boolean; grantsListener: boolean };
}

function adminUiDir(): string | null {
  // 通过包公开入口定位资源；package.json 未被 exports 公开，且安装后的 pnpm
  // 目录与 monorepo 不同，不能依赖 ../../admin 的工作区相对路径。
  const entry = createRequire(import.meta.url).resolve('@yss123/cage-admin');
  const dir = resolve(dirname(entry), '../ui');
  return existsSync(dir) ? dir : null;
}

export function createServer(opts: ServerOptions): CageServer {
  const production = process.env.NODE_ENV === 'production';
  const configuredSecret = opts.cookieSecret ?? process.env.CAGE_COOKIE_SECRET;
  if (production && (!configuredSecret || Buffer.byteLength(configuredSecret) < 32 || /change.?me|replace.with|cage-dev-cookie-secret/i.test(configuredSecret))) {
    throw new Error('[CAGE-ENV-002] 生产环境必须配置至少 32 字节的 CAGE_COOKIE_SECRET，不能使用开发占位值');
  }
  if (opts.bootstrap) throw new Error('[CAGE-ENV-003] 服务启动不再隐式初始化组织；请在受控初始化入口显式调用 bootstrapOrg 并安全交付初始凭据');
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 2000;
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1) throw new Error('[CAGE-ENV-002] readinessTimeoutMs 必须为正整数');
  // 开发会话密钥也是随机值，重启会使旧 CSRF/OIDC cookie 失效；多实例必须显式共享配置。
  const cookieSecret = configuredSecret ?? randomBytes(32).toString('hex');
  const urls = opts.urls ?? urlsFromEnv();
  // 组织模型永远在注册表里（同一对象重复导出会自动去重）。
  const kernel = createKernel({ domain: [adminDomain, opts.domain], urls, logger: undefined });
  const files = new FileService(kernel, opts.files);
  const services = runtimeServices(kernel);
  const app = Fastify({
    bodyLimit: 1_048_576, // 请求体最大 1 MB
    trustProxy: opts.trustProxy ?? false,
    logger: opts.logger === false ? false : buildLogger(kernel.registry) as any,
    genReqId: () => crypto.randomUUID(),
  });
  if (opts.logger !== false) (kernel as any).log = app.log;
  const cache = new CtxCache(kernel);
  let closing = false;
  let fileCleanup: Promise<void> | null = null;
  let fileTimer: NodeJS.Timeout | undefined;
  const cleanFiles = () => {
    if (closing || fileCleanup) return;
    fileCleanup = files.cleanup().catch(err => kernel.log.error({ err }, '文件清理失败，将在下一周期重试')).finally(() => { fileCleanup = null; });
  };
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(fileTimer);
    await files.close();
    await Promise.all(services.map(service => service.close()));
    await fileCleanup;
  });
  const probes = new Map<'appDb' | 'readDb', Promise<boolean>>();
  const probe = async (name: 'appDb' | 'readDb') => {
    // 超时的探测不重复申请连接，避免依赖故障时探针本身耗尽连接池。
    let pending = probes.get(name);
    if (!pending) {
      pending = Promise.resolve().then(() => name === 'appDb'
        ? sql`select 1 from sys.user limit 0`.execute(kernel.app)
        : sql`select 1 from safe.user limit 0`.execute(kernel.readDb)).then(() => true, () => false);
      probes.set(name, pending);
      void pending.finally(() => probes.delete(name));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), readinessTimeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const health = async (): Promise<ServerHealth> => {
    const [appDb, readDb] = closing ? [false, false] : await Promise.all([probe('appDb'), probe('readDb')]);
    const dependencies = { appDb, readDb, grantsListener: cache.healthy };
    return { ok: !closing && Object.values(dependencies).every(Boolean), dependencies };
  };
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
    await app.register(cookie, { secret: cookieSecret });
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
      const path = req.url.split('?')[0];
      // History 路由的深链接由业务 SPA 接管；API、系统管理和静态资源有各自的 404。
      // 只有浏览器请求页面时回退，不能把丢失的 JS/CSS 或未知写接口伪装成成功 HTML。
      const backendOrAsset = /^\/(api|hooks|auth|admin|assets)(\/|$)/.test(path);
      const page = (req.method === 'GET' || req.method === 'HEAD') && req.headers.accept?.includes('text/html');
      if (page && !backendOrAsset && opts.webDir && existsSync(join(opts.webDir, 'index.html')))
        return reply.sendFile('index.html', opts.webDir);
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
    app.get('/readyz', async (_req, reply) => {
      const state = await health();
      return reply.status(state.ok ? 200 : 503).send(state);
    });
    const routes = registerRoutes(app, kernel);
    await registerFiles(app, files);
    app.get('/api/openapi.json', async () => buildOpenApi(kernel, routes, { title: opts.title }));
    if (opts.admin !== false) {
      // CLI dev 和部署均以项目根为工作目录。展示文案复用已有图谱配置，业务无需维护两份翻译。
      // 直接调用 createServer 的应用也可通过 adminLabels 提供文案，不依赖文件。
      const configFile = resolve('cage.config.json');
      const labels = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')).graph?.labels : {};
      adminRoutes(app, kernel, { ...labels, ...opts.adminLabels });
    }
    const engines = kernel.registry.extensions.filter((e) => e.kind === 'ROUTE').map((e) => e.value.engine(kernel) as InCodeEngine);
    if (engines.length) approvalRoutes(app, { kernel, engines, ctxOf: (req) => req.cageCtx });
    for (const service of services) {
      await service.ready();
      await service.http?.(app);
    }

    const ui = opts.admin !== false ? adminUiDir() : null;
    if (ui) {
      await app.register(fastifyStatic, { root: ui, prefix: '/admin/', decorateReply: !opts.webDir });
      app.get('/admin', (_req, reply) => reply.redirect('/admin/'));
    }
    if (opts.webDir && existsSync(opts.webDir)) {
      await app.register(fastifyStatic, { root: opts.webDir, prefix: '/', decorateReply: true, wildcard: false });
    }
    await cache.listen(urls.app);
    await app.ready();
    if (kernel.registry.aggregates.some(a => Object.values(a.fields).some((f: any) => f.kind === 'file' || f.kind === 'files'))) {
      cleanFiles();
      fileTimer = setInterval(cleanFiles, 60_000);
      fileTimer.unref();
    }
    return app;
  };

  let readyP: Promise<FastifyInstance> | null = null;
  const ready = () => (readyP ??= build());

  return {
    app,
    kernel,
    files,
    ready,
    health,
    async listen(l = {}) {
      await ready();
      const port = l.port ?? opts.port ?? Number(process.env.PORT ?? 3000);
      const host = l.host ?? opts.host ?? process.env.HOST ?? '0.0.0.0';
      const addr = await app.listen({ port, host });
      kernel.log.info({ addr }, 'api 已启动');
      return addr;
    },
    async close() {
      closing = true;
      await app.close();
      await cache.close();
      await kernel.close();
    },
  };
}
