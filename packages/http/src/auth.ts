// 认证：服务端会话 + 会话 cookie。优先对接公司 SSO（OIDC，见 oidc.ts），没有 SSO 时用账号密码加二次认证。
// 之后每个请求都由认证钩子把会话变成上下文 ctx。
/** HTTP 认证层只确定“谁在请求”和会话的二次认证时间，不决定某条业务命令是否可执行。
 * 密码校验使用有界异步队列；Cookie 保存随机原始会话 ID，数据库仅存其 SHA-256。
 * 业务能力与范围由 CtxCache 当前解析，最终写权限仍在 Kernel.execute 中执行。
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { anonymousCtx, cageError, DEFAULT_TENANT, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { CtxCache } from './ctx.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** 认证钩子总会设置；未登录请求也有带租户/请求号的匿名上下文。 */
    cageCtx: Ctx;
    /** id 为数据库中的会话摘要，stepUpAt 为毫秒时间戳；没有有效会话时为 null。 */
    cageSession: { id: string; userId: string; tenantId: string; stepUpAt: number | null } | null;
    /** JSON 解析前的文本，仅为第三方回调验签保留，不应写入日志。 */
    rawBody?: string;
  }
}

/** 浏览器认证 Cookie 的固定名称；不是凭据值，也不保存用户角色。 */
export const SESSION_COOKIE = 'cage_sid';

/** 服务端认证策略；缺省值面向普通会话，部署层应显式提供 OIDC 和生产 Cookie 配置。 */
export interface AuthOptions {
  /** 会话时长（小时），默认 8 */
  sessionHours?: number;
  /** cookie 只走 HTTPS；默认生产环境开启 */
  cookieSecure?: boolean;
  /** 是否开放账号密码登录，默认开启 */
  password?: boolean;
  /** 单进程正在执行的密码派生上限，默认 4；排队满后返回 RATE_LIMITED。 */
  passwordConcurrency?: number;
  /** 等待派生的请求上限，默认 32。 */
  passwordQueueLimit?: number;
  /** 可选授权码/PKCE 登录配置；clientSecret 仅保留在服务端，deptClaim 指向部门 code 的 claim 名。 */
  oidc?: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scope?: string; deptClaim?: string };
}

/** 以摘要查询/删除会话，避免数据库泄露时原始 Cookie 直接成为可用凭据。 */
const hashSid = (sid: string) => createHash('sha256').update(sid).digest('hex');

/** 将 CPU/内存密集的 scrypt 交给异步实现；调用数量仍须由 PasswordVerifier 约束。 */
const derivePassword = (pw: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(pw, salt, 32, (error, key) => error ? reject(error) : resolve(key));
});

/** 核对 scrypt$salt$hash 格式；缺少账户时仍做派生以减弱计时枚举，摘要采用恒时比较。 */
async function comparePassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    await derivePassword(pw, 'timing-equalizer'); // 用户不存在时也做一次哈希，避免按耗时探测用户名
    return false;
  }
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = await derivePassword(pw, salt);
  const want = Buffer.from(hash, 'hex');
  return want.length === got.length && timingSafeEqual(got, want);
}

/** 异步派生仍消耗有限线程和内存，因此执行和等待队列都必须有上限。 */
export class PasswordVerifier {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  /** concurrency 是同时派生个数，queueLimit 是额外等待个数；非法配置在启动期抛 CAGE-ENV-002。 */
  constructor(private readonly concurrency = 4, private readonly queueLimit = 32) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 0) {
      throw new Error('[CAGE-ENV-002] passwordConcurrency 必须为正整数，passwordQueueLimit 必须为非负整数');
    }
  }

  /** 当前进程预算快照，仅用于观测；不是跨实例的全局限流计数。 */
  get state(): { active: number; queued: number } { return { active: this.active, queued: this.waiting.length }; }

  /** 先校验长度再占用执行槽；排队满抛 RATE_LIMITED，校验不匹配返回 false，派生异常继续上抛。
   * finally 把槽直接移交给下一等待者，保证失败请求也会释放容量。
   */
  async verify(pw: string, stored: string | null | undefined): Promise<boolean> {
    if (pw.length < 1 || pw.length > 200) throw cageError('INVALID_INPUT', [{ path: 'password', message: '密码长度必须在 1 到 200 个字符之间' }]);
    if (this.active < this.concurrency) this.active++;
    else {
      if (this.waiting.length >= this.queueLimit) throw cageError('RATE_LIMITED');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try { return await comparePassword(pw, stored); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const defaultVerifier = new PasswordVerifier();
/** 使用模块共享的默认有界校验器；HTTP 实例可另建 PasswordVerifier 使用自己的预算配置。 */
export function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  return defaultVerifier.verify(pw, stored);
}

/** 把登录字段的格式错误统一成路径化 INVALID_INPUT；在任何密码派生前限制输入规模。 */
function loginInput(raw: unknown): { username: string; password: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const issues = [];
  if (typeof body.username !== 'string' || body.username.length < 1 || body.username.length > 64) issues.push({ path: 'username', message: '用户名长度必须在 1 到 64 个字符之间' });
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 200) issues.push({ path: 'password', message: '密码长度必须在 1 到 200 个字符之间' });
  if (issues.length) throw cageError('INVALID_INPUT', issues);
  return body as { username: string; password: string };
}

/** 服务端会话持久化。调用方传入原始 sid 做验证/销毁，二次认证更新则使用已验证的数据库摘要 ID。 */
export class Sessions {
  /** hours 为会话寿命小时数；构造函数不创建会话，也不延长已有会话。 */
  constructor(private readonly k: Kernel, private readonly hours: number) {}

  /** 为已认证用户生成 32 字节随机会话并保存摘要/到期时间；原始 sid 仅返回给 Cookie 写入方。 */
  async create(userId: string, tenantId: string, req: FastifyRequest): Promise<string> {
    const sid = randomBytes(32).toString('base64url');
    await this.k.app
      .insertInto('sys.session')
      .values({
        id: hashSid(sid), user_id: userId, tenant_id: tenantId, expires_at: new Date(Date.now() + this.hours * 3600_000),
        ip: req.ip, user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      })
      .execute();
    return sid;
  }

  /** 只读取仍未过期的会话，未命中返回 null；用户是否禁用和当前授权由后续上下文解析复核。 */
  async verify(sid: string) {
    const row = await this.k.app.selectFrom('sys.session').selectAll().where('id', '=', hashSid(sid)).where('expires_at', '>', new Date()).executeTakeFirst();
    return row ? { id: row.id as string, userId: row.user_id as string, tenantId: row.tenant_id as string, stepUpAt: row.step_up_at ? new Date(row.step_up_at).getTime() : null } : null;
  }

  /** 幂等删除该原始 Cookie 对应的会话；不存在也视为退出完成。 */
  async destroy(sid: string) {
    await this.k.app.deleteFrom('sys.session').where('id', '=', hashSid(sid)).execute();
  }

  /** 密码复核成功后记录数据库当前时间，后续命令的 stepUp 约束据此判断认证是否足够新。 */
  async stepUp(sessionId: string) {
    await this.k.app.updateTable('sys.session').set({ step_up_at: sql`now()` }).where('id', '=', sessionId).execute();
  }
}

/** 交付 HttpOnly 会话 Cookie；maxAge 单位秒，与服务端会话小时数对应。CSRF 仍需独立令牌校验。 */
export function setSessionCookie(reply: FastifyReply, sid: string, opts: AuthOptions) {
  reply.setCookie(SESSION_COOKIE, sid, {
    httpOnly: true, // 前端脚本读不到，防 XSS 窃取
    secure: opts.cookieSecure ?? process.env.NODE_ENV === 'production',
    sameSite: 'lax', // 防跨站请求伪造
    path: '/',
    maxAge: (opts.sessionHours ?? 8) * 3600,
  });
}

/** 认证钩子：每个请求最先执行，把会话变成上下文 */
/** 先建立匿名上下文，再用有效 Cookie 和当前授权补全身份；健康探针/验签回调不解析用户会话。
 * 无效 Cookie 不在此直接抛错，让各路由按是否需要登录决定拒绝行为；请求元数据不能跨请求缓存。
 */
export function registerAuthHook(app: FastifyInstance, k: Kernel, sessions: Sessions, cache: CtxCache) {
  app.decorateRequest('cageCtx', null as any);
  app.decorateRequest('cageSession', null);
  app.addHook('onRequest', async (req) => {
    const base: Partial<Ctx> = {
      requestId: String(req.id),
      client: { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) },
    };
    req.cageCtx = anonymousCtx(DEFAULT_TENANT, base);
    if (req.url.split('?')[0] === '/healthz' || req.url.split('?')[0] === '/readyz') return;
    if (req.url.startsWith('/hooks/')) return; // 第三方回调走签名验证，不走用户登录
    const sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) return;
    const s = await sessions.verify(sid);
    if (!s) return;
    const ctx = await cache.resolve(s.userId, s.tenantId);
    if (!ctx) return;
    req.cageSession = s;
    req.cageCtx = { ...ctx, ...base, stepUpAt: s.stepUpAt, source: 'api' };
  });
}

/** 登录专用最小字段查询，包含密码摘要但不返回给前端；租户条件不可省略。 */
export async function findLoginUser(k: Kernel, username: string, tenantId = DEFAULT_TENANT) {
  return k.app
    .selectFrom('sys.user')
    .select(['id', 'tenant_id', 'password_hash', 'status'])
    .where('username', '=', username)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
}

/** 提供与 CSRF Cookie 配对的请求令牌；客户端后续写请求将该值放入框架要求的请求头。 */
export function csrfRoute(app: FastifyInstance) {
  app.get('/auth/csrf', async (_req, reply) => ({ token: reply.generateCsrf() }));
}

/** 安装密码登录、二次认证、退出和当前用户接口；由 server 的认证限流作用域承载。
 * 登录失败审计尽力写入但始终拒绝登录；禁用密码登录不会禁用退出或已有会话的 /api/me。
 * /api/me 公开当前能力与范围供 UI 展示，不能代替后端对下一次操作的重新授权。
 */
export function authRoutes(app: FastifyInstance, k: Kernel, sessions: Sessions, opts: AuthOptions) {
  const verifier = new PasswordVerifier(opts.passwordConcurrency, opts.passwordQueueLimit);

  if (opts.password !== false) {
    app.post('/auth/login', async (req, reply) => {
      const body = loginInput(req.body);
      const u = await findLoginUser(k, body.username);
      const ok = await verifier.verify(body.password, u?.password_hash) && u?.status === 'active';
      if (!u || !ok) {
        await k.writeAudit(k.app, {
          tenantId: DEFAULT_TENANT, actor: u?.id ?? `anonymous:${body.username.slice(0, 64)}`, actorKind: 'anonymous', source: 'api',
          kind: 'denied', command: 'auth.login', result: 'UNAUTHENTICATED', requestId: String(req.id), client: { ip: req.ip },
        }).catch((error) => {
          k.log.error({ err: error, code: 'AUTH_AUDIT_FAILED', requestId: req.id }, '登录拒绝审计写入失败');
        });
        throw cageError('UNAUTHENTICATED');
      }
      const sid = await sessions.create(u.id, u.tenant_id, req);
      setSessionCookie(reply, sid, opts);
      return { ok: true };
    });

    app.post('/auth/step-up', async (req) => {
      if (!req.cageSession) throw cageError('UNAUTHENTICATED');
      const pw = (req.body as any)?.password;
      if (typeof pw !== 'string' || pw.length < 1 || pw.length > 200) throw cageError('INVALID_INPUT', [{ path: 'password', message: '密码长度必须在 1 到 200 个字符之间' }]);
      const row = await k.app.selectFrom('sys.user').select('password_hash').where('id', '=', req.cageSession.userId).executeTakeFirst();
      if (!await verifier.verify(pw, row?.password_hash)) throw cageError('UNAUTHENTICATED');
      await sessions.stepUp(req.cageSession.id);
      return { ok: true };
    });
  }

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) await sessions.destroy(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const ctx = req.cageCtx;
    if (!ctx.userId) throw cageError('UNAUTHENTICATED');
    const u = await k.app.selectFrom('sys.user').select(['id', 'username', 'name', 'dept_id']).where('id', '=', ctx.userId).executeTakeFirst();
    return {
      user: u ? { id: u.id, username: u.username, name: u.name, deptId: u.dept_id } : null,
      tenantId: ctx.tenantId,
      capabilities: [...ctx.capabilities.keys()].sort(),
      scopes: ctx.scopes,
      stepUpAt: ctx.stepUpAt ?? null,
    };
  });
}
