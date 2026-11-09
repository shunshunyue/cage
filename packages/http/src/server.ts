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

/** HTTP 进程的组合配置；领域声明决定能力与路由，选项只负责部署、认证和服务生命周期。 */
export interface ServerOptions {
  /** 私有文件存储与上传限制；默认本地 .cage-files。 */
  files?: FileServiceOptions;
  /** domain 包的导出：import * as domain from '@app/domain' */
  domain: object;
  /** 写账号与只读账号由内核分别使用；省略时从项目环境读取，不在启动时建库或执行迁移。 */
  urls?: DatabaseUrls;
  /** 密码认证选项及可选 OIDC issuer；具体凭据来源由认证模块和部署环境决定。 */
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
  /** 默认监听端口；listen 调用参数优先，其次本选项、PORT 环境变量，最后 3000。 */
  port?: number;
  /** 默认监听地址；listen 调用参数优先，其次本选项、HOST 环境变量，最后 0.0.0.0。 */
  host?: string;
  /** 默认每个客户端每分钟 300 次 */
  rateLimitPerMinute?: number;
  /** 登录类接口每个客户端每分钟次数，默认 10 */
  authRateLimitPerMinute?: number;
  /** 关闭 CSRF（只用于测试） */
  csrf?: boolean;
  /** false 关闭 HTTP 日志；默认启用框架脱敏日志配置。 */
  logger?: boolean;
  /** 可选 OpenAPI 文档标题，仅用于接口说明。 */
  title?: string;
}

/** 已创建但未必已开始监听的服务；嵌入式测试可只调用 ready，再通过 app 注入请求。 */
export interface CageServer {
  /** 本服务拥有的文件协调器，HTTP 上传路由与关闭流程使用同一实例。 */
  files: FileService;
  /** Fastify 实例；ready 之后可用 inject 测试，listen 后才接受网络连接。 */
  app: FastifyInstance;
  /** 本 HTTP 服务装配的内核，业务请求通过它执行命令和安全读取。 */
  kernel: Kernel;
  /** 注册路由、启动扩展与授权监听；重复调用共享同一次初始化及其失败结果。 */
  ready(): Promise<FastifyInstance>;
  /** 检查数据库及授权监听等就绪依赖，返回状态快照，不证明异步业务已完成。 */
  health(): Promise<ServerHealth>;
  /** 先完成 ready，再按参数/配置监听网络；返回监听地址，启动失败向调用方抛出。 */
  listen(opts?: { port?: number; host?: string }): Promise<string>;
  /** 关闭 HTTP 及其装配资源；由宿主退出流程调用，不能把停止接收请求当作业务回滚。 */
  close(): Promise<void>;
}

/** 就绪状态只覆盖当前 HTTP 进程依赖；异步 worker 的消费健康需单独探测。 */
export interface ServerHealth {
  /** 当前就绪依赖均满足时为 true，不代表整个部署的 worker 或外部系统健康。 */
  ok: boolean;
  /** appDb/readDb 为连接探测，grantsListener 为授权监听状态；不包含秘密连接信息。 */
  dependencies: { appDb: boolean; readDb: boolean; grantsListener: boolean };
}

/** 从实际安装的 admin 包定位已构建静态资源；未附带 UI 时返回 null，仍可注册管理 API。 */
function adminUiDir(): string | null {
  // 通过包公开入口定位资源；package.json 未被 exports 公开，且安装后的 pnpm
  // 目录与 monorepo 不同，不能依赖 ../../admin 的工作区相对路径。
  const entry = createRequire(import.meta.url).resolve('@yss123/cage-admin');
  const dir = resolve(dirname(entry), '../ui');
  return existsSync(dir) ? dir : null;
}

/**
 * 组合组织模型、业务内核、文件服务和 HTTP 安全基线，返回由调用者掌控的启动/停止句柄。
 * 创建阶段校验环境并建立资源对象，ready 才注册插件、扩展和监听；不会初始化组织或更新数据库。
 * 生产密钥无效或显式要求隐式 bootstrap 时立即失败，避免服务启动产生不可审查的管理凭据。
 * close 先停止 HTTP 及扩展后台活动，再关闭授权监听与内核连接，防止清理任务访问已关闭的连接池。
 */
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
  /** 一次只允许一个清理批次运行；失败留待下周期重试，停止时等待当前批次完成。 */
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
  /** 检查账号能否访问它应访问的 schema；超时只结束本次等待，不取消底层尚未返回的查询。 */
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
  /** readiness 同时要求写库、只读安全视图和撤权通知可用；关闭期间固定为不可接流量。 */
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

  /** 注册顺序保证会话、CSRF 和统一错误处理覆盖业务路由；原始 JSON 同时供第三方回调验签。 */
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

  // 共享初始化 Promise，避免 listen、测试和健康管理代码并发调用时重复挂载路由或后台任务。
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
