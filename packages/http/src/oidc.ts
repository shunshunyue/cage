// SSO 登录（OIDC 授权码 + PKCE）。首次登录创建用户（默认没有任何角色），之后更新姓名和部门。
// 创建和更新用户都是命令，以 external 身份调用，同样被鉴权、写审计。
import { createHash, randomBytes } from 'node:crypto';
import { cageError, DEFAULT_TENANT, systemCtx, type Kernel } from '@yss123/cage-kernel';
import type { FastifyInstance } from 'fastify';
import { setSessionCookie, type AuthOptions, type Sessions } from './auth.js';

/** 当前授权码流程实际消费的发现端点；access token 仅用于 userinfo，不作为 Cage 会话凭据。 */
interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

/** 按需注册 SSO 跳转和回调。签名短期 Cookie 保存 state/PKCE verifier，回调核对后即清除。
 * 身份提供方网络访问发生在业务命令事务外；拿到 userinfo 后通过组织命令同步，再创建本地会话。
 * 无 oidc 配置则不挂载路由；令牌或用户信息端点返回非成功状态时按 UNAUTHENTICATED 拒绝，不降级本地登录。
 */
export function oidcRoutes(app: FastifyInstance, k: Kernel, sessions: Sessions, opts: AuthOptions) {
  const o = opts.oidc;
  if (!o) return;
  let disco: Promise<Discovery> | null = null;
  const discover = () =>
    (disco ??= fetch(new URL('.well-known/openid-configuration', o.issuer.endsWith('/') ? o.issuer : `${o.issuer}/`)).then(async (r) => {
      if (!r.ok) throw new Error(`[CAGE-AUTH-001] OIDC 发现文档获取失败：${r.status}`);
      return (await r.json()) as Discovery;
    }));
  const secure = opts.cookieSecure ?? process.env.NODE_ENV === 'production';

  app.get('/auth/sso', async (_req, reply) => {
    const d = await discover();
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    reply.setCookie('cage_oidc', JSON.stringify({ state, verifier }), { httpOnly: true, secure, sameSite: 'lax', path: '/auth', maxAge: 600, signed: true });
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', o.clientId);
    u.searchParams.set('redirect_uri', o.redirectUri);
    u.searchParams.set('scope', o.scope ?? 'openid profile email');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return reply.redirect(u.toString());
  });

  app.get('/auth/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    const raw = req.cookies['cage_oidc'];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    const saved = unsigned?.valid && unsigned.value ? JSON.parse(unsigned.value) : null;
    if (!q.code || !saved || saved.state !== q.state) throw cageError('UNAUTHENTICATED');
    reply.clearCookie('cage_oidc', { path: '/auth' });
    const d = await discover();
    const tok = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: q.code, redirect_uri: o.redirectUri,
        client_id: o.clientId, client_secret: o.clientSecret, code_verifier: saved.verifier,
      }),
    });
    if (!tok.ok) throw cageError('UNAUTHENTICATED');
    const { access_token } = (await tok.json()) as { access_token: string };
    const info = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${access_token}` } });
    if (!info.ok) throw cageError('UNAUTHENTICATED');
    const claims = (await info.json()) as Record<string, any>;
    const user = await upsertUserFromSso(k, claims, o.deptClaim);
    const sid = await sessions.create(user.id, DEFAULT_TENANT, req);
    setSessionCookie(reply, sid, opts);
    return reply.redirect('/');
  });
}

/** 将可信 userinfo 映射为默认租户用户，按 SSO subject 或用户名寻找已有身份。
 * 部门 claim 按 code 匹配，缺失/未命中时归根部门；已有禁用用户不可借 SSO 重新激活。
 * external 上下文仅授 User.create/update，所有写入仍走内核审计；不会自动分配任何业务角色。
 */
export async function upsertUserFromSso(k: Kernel, claims: Record<string, any>, deptClaim = 'department'): Promise<{ id: string }> {
  const tenantId = DEFAULT_TENANT;
  const ctx = systemCtx({ kind: 'external', name: 'sso', tenantId, capabilities: ['User.create', 'User.update'] });
  const subject = String(claims.sub);
  const username = String(claims.preferred_username ?? claims.email ?? subject).slice(0, 64);
  const name = String(claims.name ?? username).slice(0, 100);
  const deptCode = claims[deptClaim];
  const dept =
    (deptCode && (await k.app.selectFrom('sys.dept').select('id').where('code', '=', String(deptCode)).where('tenant_id', '=', tenantId).executeTakeFirst())) ||
    (await k.app.selectFrom('sys.dept').select('id').where('code', '=', 'root').where('tenant_id', '=', tenantId).executeTakeFirstOrThrow());
  const existing = await k.app.selectFrom('sys.user').select(['id', 'status']).where('tenant_id', '=', tenantId)
    .where((eb) => eb.or([eb('sso_subject', '=', subject), eb('username', '=', username)])).executeTakeFirst();
  if (existing) {
    if (existing.status !== 'active') throw cageError('UNAUTHENTICATED');
    await k.execute('User.update', { id: existing.id, name, deptId: dept.id }, ctx);
    return { id: existing.id };
  }
  const u = await k.execute('User.create', { username, name, deptId: dept.id, ssoSubject: subject, email: claims.email ?? null }, ctx);
  return { id: u.id };
}
