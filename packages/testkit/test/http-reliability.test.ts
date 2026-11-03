// 安全边界回归使用隔离测试库；故障注入只终止本文件创建的监听连接。
import { scryptSync } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import * as adminDomain from '@yss123/cage-admin/domain';
import { bootstrapOrg, hashPassword } from '@yss123/cage-admin';
import { aggregate, buildRegistry, list, text, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { buildLogger, createLogSanitizer, createSafeLogger, createServer, CtxCache, PasswordVerifier, verifyPassword, type CageServer } from '@yss123/cage-http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestEnv, type TestEnv } from '../src/index.js';

let env: TestEnv;
const servers: CageServer[] = [];
beforeAll(async () => { env = await createTestEnv({ domain: adminDomain }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => {
  for (const server of servers) await server.close();
  await env?.close();
});
const server = async (options: Partial<Parameters<typeof createServer>[0]> = {}) => {
  const instance = createServer({ domain: {}, urls: env.urls, logger: false, admin: false, csrf: false, ...options });
  servers.push(instance);
  await instance.ready();
  return instance;
};

describe('HTTP 运行边界', () => {
  it('默认不初始化组织、不信任来源头；可信代理需显式配置', async () => {
    const direct = await server({ rateLimitPerMinute: 1 });
    expect((await direct.kernel.app.selectFrom('sys.user').selectAll().execute())).toHaveLength(0);
    expect((await direct.app.inject({ url: '/healthz', headers: { 'x-forwarded-for': '192.0.2.1' } })).statusCode).toBe(200);
    expect((await direct.app.inject({ url: '/healthz', headers: { 'x-forwarded-for': '192.0.2.2' } })).statusCode).toBe(429);
    const trusted = await server({ trustProxy: '127.0.0.1', rateLimitPerMinute: 1 });
    expect((await trusted.app.inject({ url: '/healthz', headers: { 'x-forwarded-for': '192.0.2.1' } })).statusCode).toBe(200);
    expect((await trusted.app.inject({ url: '/healthz', headers: { 'x-forwarded-for': '192.0.2.2' } })).statusCode).toBe(200);
  });

  it('生产缺少或使用占位密钥时在建立连接前拒绝启动', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CAGE_COOKIE_SECRET', '');
    expect(() => createServer({ domain: {} })).toThrow('CAGE-ENV-002');
    expect(() => createServer({ domain: {}, cookieSecret: 'cage-dev-cookie-secret-change-me' })).toThrow('CAGE-ENV-002');
    expect(() => createServer({ domain: {}, bootstrap: true, cookieSecret: 'test-only-cookie-secret-with-enough-length' })).toThrow('CAGE-ENV-003');
  });

  it('就绪检查反映数据库故障，存活检查与 Cookie 认证独立', async () => {
    const instance = await server();
    expect((await instance.app.inject({ url: '/readyz' })).statusCode).toBe(200);
    const spy = vi.spyOn(instance.kernel.readDb, 'getExecutor').mockImplementation(() => { throw new Error('synthetic unavailable'); });
    const ready = await instance.app.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ ok: false, dependencies: { readDb: false, grantsListener: true } });
    expect((await instance.app.inject({ url: '/healthz', headers: { cookie: 'cage_sid=synthetic' } })).statusCode).toBe(200);
    spy.mockRestore();
  });

  it('登录输入在查询和派生前校验；登录拒绝的审计故障可观测', async () => {
    const instance = await server();
    const lookup = vi.spyOn(instance.kernel.app, 'selectFrom');
    const invalid = await instance.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'x'.repeat(65), password: 'x'.repeat(201) } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().detail.map((issue: any) => issue.path)).toEqual(['username', 'password']);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
    const audit = vi.spyOn(instance.kernel, 'writeAudit').mockRejectedValue(new Error('synthetic storage failure'));
    const log = vi.spyOn(instance.kernel.log, 'error').mockImplementation(() => {});
    const denied = await instance.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'nonexistent', password: 'valid-shape-password' } });
    expect(denied.statusCode).toBe(401);
    expect(audit).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_AUDIT_FAILED' }), expect.any(String));
  });
});

it('任意深度的对象和数组脱敏；默认日志不接收原始载荷或错误文本', () => {
  const LogShape = aggregate('LogShape', { fields: { entries: list({ privatePhone: text().sensitive('phone') }) } });
  const registry = buildRegistry({ ...adminDomain, LogShape });
  const sanitize = createLogSanitizer(registry);
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  const input = { nested: [{ child: { phone: marker, privatePhone: marker, private_phone: marker, password: marker, passwordHash: marker, email: marker, err: new Error(marker), url: `/api/list?token=${marker}` } }] };
  expect(JSON.stringify(sanitize(input))).not.toContain(marker);
  expect(input.nested[0].child.phone).toBe(marker);
  const logger = buildLogger(registry) as any;
  const record = logger.formatters.log({ requestId: 'trace-1', payload: input, err: new Error(marker), url: `/api/list?token=${marker}`, req: { id: 'trace-1', method: 'POST', url: '/api/list', body: input, headers: { authorization: marker } } });
  expect(record.requestId).toBe('trace-1');
  expect(record.payload).toBeUndefined();
  expect(JSON.stringify(record)).not.toContain(marker);
  expect(record.err).toEqual({ type: 'Error' });
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  createSafeLogger(registry).error({ outboxId: 7, payload: input, err: new Error(marker) }, '事件投递失败');
  const serialized = String(output.mock.calls[0][0]);
  expect(serialized).not.toContain(marker);
  expect(JSON.parse(serialized)).toMatchObject({ outboxId: 7, err: { type: 'Error' } });
});

it('密码派生异步执行并限制执行数与排队数，错误与未知账号释放名额', async () => {
  const verifier = new PasswordVerifier(1, 1);
  const password = 'synthetic-test-password';
  const stored = `scrypt$test-salt$${scryptSync(password, 'test-salt', 32).toString('hex')}`;
  const first = verifier.verify(password, stored);
  const second = verifier.verify(password, null);
  await expect(verifier.verify(password, stored)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(verifier.state).toEqual({ active: 1, queued: 1 });
  await immediate();
  expect(await first).toBe(true);
  expect(await second).toBe(false);
  expect(verifier.state).toEqual({ active: 0, queued: 0 });
  await expect(verifyPassword('x'.repeat(201), stored)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await verifyPassword('incorrect', stored)).toBe(false);
  expect(await verifyPassword(password, await hashPassword(password))).toBe(true);
});

it('显式组织初始化失败整体回滚；并发初始化只有一次创建并可安全重试', async () => {
  const departmentsBefore = (await env.query('select count(*)::int as n from sys.dept'))[0].n;
  await expect(bootstrapOrg(env.kernel, { adminPassword: 'short' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect((await env.query('select count(*)::int as n from sys.dept'))[0].n).toBe(departmentsBefore);
  expect((await env.query('select count(*)::int as n from sys.role'))[0].n).toBe(0);
  expect((await env.query('select count(*)::int as n from sys.user'))[0].n).toBe(0);
  const password = 'synthetic-bootstrap-password';
  const attempts = await Promise.all([bootstrapOrg(env.kernel, { adminPassword: password }), bootstrapOrg(env.kernel, { adminPassword: password })]);
  expect(attempts.map((result) => result.created).sort()).toEqual([false, true]);
  expect((await env.query('select count(*)::int as n from sys.user'))[0].n).toBe(1);
  const [user] = await env.query('select password_hash from sys.user');
  expect(await verifyPassword(password, user.password_hash)).toBe(true);
});

it('授权断线期间实时复核，恢复后不复用旧缓存，在途解析不能重新填回旧值', async () => {
  let current = { marker: 'before' } as unknown as Ctx;
  const resolve = vi.fn(async () => current);
  const cache = new CtxCache({ contextFor: resolve, log: { warn: vi.fn() } } as unknown as Kernel);
  try {
    await cache.listen(env.urls.app);
    expect(cache.healthy).toBe(true);
    expect(await cache.resolve('user', 'tenant')).toBe(current);
    expect(await cache.resolve('user', 'tenant')).toBe(current);
    expect(resolve).toHaveBeenCalledTimes(1);
    const pid = (cache as any).listener.processID;
    await env.query('select pg_terminate_backend($1)', [pid]);
    await expect.poll(() => cache.healthy).toBe(false);
    await cache.resolve('user', 'tenant');
    current = { marker: 'revoked' } as unknown as Ctx;
    expect(await cache.resolve('user', 'tenant')).toBe(current);
    await cache.listen(env.urls.app);
    expect(await cache.resolve('user', 'tenant')).toBe(current);
    cache.invalidate('*');
    let release!: (value: Ctx) => void;
    resolve.mockImplementationOnce(() => new Promise<Ctx>((done) => { release = done; }));
    const inFlight = cache.resolve('user', 'tenant');
    cache.invalidate('user');
    release({ marker: 'stale-query' } as unknown as Ctx);
    await inFlight;
    expect(await cache.resolve('user', 'tenant')).toBe(current);
  } finally { await cache.close(); }
});
