// 认证：服务端会话 + 会话 cookie。优先对接公司 SSO（OIDC，见 oidc.ts），没有 SSO 时用账号密码加二次认证。
// 之后每个请求都由认证钩子把会话变成上下文 ctx。
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { anonymousCtx, cageError, DEFAULT_TENANT, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { CtxCache } from './ctx.js';

declare module 'fastify' {
  interface FastifyRequest {
    cageCtx: Ctx;
    cageSession: { id: string; userId: string; tenantId: string; stepUpAt: number | null } | null;
    rawBody?: string;
  }
}

export const SESSION_COOKIE = 'cage_sid';

export interface AuthOptions {
  /** 会话时长（小时），默认 8 */
  sessionHours?: number;
  /** cookie 只走 HTTPS；默认生产环境开启 */
  cookieSecure?: boolean;
  /** 是否开放账号密码登录，默认开启 */
  password?: boolean;
  oidc?: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scope?: string; deptClaim?: string };
}

const hashSid = (sid: string) => createHash('sha256').update(sid).digest('hex');

export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored) {
    scryptSync(pw, 'timing-equalizer', 32); // 用户不存在时也做一次哈希，避免按耗时探测用户名
    return false;
  }
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = scryptSync(pw, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return want.length === got.length && timingSafeEqual(got, want);
}

export class Sessions {
  constructor(private readonly k: Kernel, private readonly hours: number) {}

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

  async verify(sid: string) {
    const row = await this.k.app.selectFrom('sys.session').selectAll().where('id', '=', hashSid(sid)).where('expires_at', '>', new Date()).executeTakeFirst();
    return row ? { id: row.id as string, userId: row.user_id as string, tenantId: row.tenant_id as string, stepUpAt: row.step_up_at ? new Date(row.step_up_at).getTime() : null } : null;
  }

  async destroy(sid: string) {
    await this.k.app.deleteFrom('sys.session').where('id', '=', hashSid(sid)).execute();
  }

  async stepUp(sessionId: string) {
    await this.k.app.updateTable('sys.session').set({ step_up_at: sql`now()` }).where('id', '=', sessionId).execute();
  }
}

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
export function registerAuthHook(app: FastifyInstance, k: Kernel, sessions: Sessions, cache: CtxCache) {
  app.decorateRequest('cageCtx', null as any);
  app.decorateRequest('cageSession', null);
  app.addHook('onRequest', async (req) => {
    const base: Partial<Ctx> = {
      requestId: String(req.id),
      client: { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) },
    };
    req.cageCtx = anonymousCtx(DEFAULT_TENANT, base);
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

export async function findLoginUser(k: Kernel, username: string, tenantId = DEFAULT_TENANT) {
  return k.app
    .selectFrom('sys.user')
    .select(['id', 'tenant_id', 'password_hash', 'status'])
    .where('username', '=', username)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
}

export function csrfRoute(app: FastifyInstance) {
  app.get('/auth/csrf', async (_req, reply) => ({ token: reply.generateCsrf() }));
}

export function authRoutes(app: FastifyInstance, k: Kernel, sessions: Sessions, opts: AuthOptions) {

  if (opts.password !== false) {
    app.post('/auth/login', async (req, reply) => {
      const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
      if (typeof body.username !== 'string' || typeof body.password !== 'string') throw cageError('INVALID_INPUT');
      const u = await findLoginUser(k, body.username);
      const ok = verifyPassword(body.password, u?.password_hash) && u?.status === 'active';
      if (!u || !ok) {
        await k.writeAudit(k.app, {
          tenantId: DEFAULT_TENANT, actor: u?.id ?? `anonymous:${body.username.slice(0, 64)}`, actorKind: 'anonymous', source: 'api',
          kind: 'denied', command: 'auth.login', result: 'UNAUTHENTICATED', requestId: String(req.id), client: { ip: req.ip },
        }).catch(() => {});
        throw cageError('UNAUTHENTICATED');
      }
      const sid = await sessions.create(u.id, u.tenant_id, req);
      setSessionCookie(reply, sid, opts);
      return { ok: true };
    });

    app.post('/auth/step-up', async (req) => {
      if (!req.cageSession) throw cageError('UNAUTHENTICATED');
      const pw = (req.body as any)?.password;
      const row = await k.app.selectFrom('sys.user').select('password_hash').where('id', '=', req.cageSession.userId).executeTakeFirst();
      if (typeof pw !== 'string' || !verifyPassword(pw, row?.password_hash)) throw cageError('UNAUTHENTICATED');
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
