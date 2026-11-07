import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import * as admin from '@yss123/cage-admin/domain';
import { ai, managedModel, chatModel } from '@yss123/cage-ai';
import { createServer } from '@yss123/cage-http';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

const intelligence = ai({ models: { main: managedModel('main') }, assistant: { model: 'main' } });
const domain = { ...admin, intelligence };
let env: TestEnv, manager: TestUser, user: TestUser;
const config = { version: 0, label: '通用模型', baseUrl: 'https://models.example.invalid/v1', model: 'model-a', apiKey: 'test-key-one', enabled: true, timeoutMs: 1000 };
const stream = () => new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
beforeAll(async () => {
  vi.stubEnv('CAGE_AI_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  env = await createTestEnv({ domain });
  manager = await env.user({ caps: ['Sys.ai.models.manage'] });
  user = await env.user({ caps: ['Sys.ai.use'] });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await intelligence.service(env.kernel).close(); await env.close(); vi.unstubAllEnvs(); });

it('模型管理独立授权、租户隔离、密文存储，响应与审计不含凭据', async () => {
  const service = intelligence.service(env.kernel).models, ctx = await manager.ctx();
  await expect(service.list(await user.ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect((await service.list(ctx))[0]).toMatchObject({ key: 'main', version: 0, hasApiKey: false });
  const saved = await service.save(ctx, 'main', config);
  expect(saved).toMatchObject({ version: 1, hasApiKey: true, apiFormat: 'chat-completions', contextWindowTokens: 32768, responsesCompaction: false });
  expect(JSON.stringify(saved)).not.toContain(config.apiKey);
  const [row] = await env.query('select encrypted_key from sys.ai_model where tenant_id = $1', [env.tenantId]);
  expect(row.encrypted_key).toMatch(/^v1:/); expect(row.encrypted_key).not.toContain(config.apiKey);
  const logs = await env.audit({ command: 'Sys.ai.models.save' });
  expect(logs).toHaveLength(1); expect(JSON.stringify(logs)).not.toContain(config.apiKey); expect(JSON.stringify(logs)).not.toContain(row.encrypted_key);
  const otherTenant = { ...ctx, tenantId: randomUUID() };
  expect((await service.list(otherTenant))[0]).toMatchObject({ version: 0, hasApiKey: false });
  await expect(service.generate(otherTenant.tenantId, 'main', { messages: [], tools: [], maxOutputTokens: 64, signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: 'DOMAIN_ERROR' });
});

it('配置版本防覆盖，留空保留密钥，更换服务地址必须提供新密钥', async () => {
  const service = intelligence.service(env.kernel).models, ctx = await manager.ctx();
  const [current] = await service.list(ctx);
  await expect(service.save(ctx, 'main', config)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(service.save(ctx, 'main', { ...config, version: current.version, apiKey: '', baseUrl: 'https://other.example.invalid/v1' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.save(ctx, 'unknown', config)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(service.save(ctx, 'main', { ...config, baseUrl: 'https://user:secret@models.example.invalid' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.save(ctx, 'main', { ...config, baseUrl: 'ftp://models.example.invalid' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.save(ctx, 'main', { ...config, baseUrl: 'invalid-address' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const results = await Promise.allSettled([1, 2].map(() => service.save(ctx, 'main', { ...config, version: current.version, apiKey: '' })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
});

it('同一个 runtime 动态切换模型、轮换密钥与停用；模型请求不含可信身份上下文', async () => {
  const runtime = intelligence.service(env.kernel), ctx = await manager.ctx();
  const requests: { body: any; token: string; url: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get('authorization')! });
    return stream();
  });
  const send = async () => { const ctx = await user.ctx(), session = await runtime.createSession(ctx); const run = await runtime.submit(ctx, session.id, { message: '你好' }, randomUUID()); await runtime.tick(); return runtime.run(ctx, run.id); };
  expect((await send()).status).toBe('succeeded');
  expect(requests[0].token).toBe('Bearer test-key-one');
  expect(JSON.stringify(requests[0].body)).not.toContain('tenantId');
  const [current] = await runtime.models.list(ctx);
  const rotated = await runtime.models.save(ctx, 'main', { ...config, version: current.version, baseUrl: 'http://127.0.0.1:18888/v2', apiKey: 'test-key-two', model: 'model-b' });
  expect((await send()).status).toBe('succeeded');
  expect(requests[1]).toMatchObject({ token: 'Bearer test-key-two', url: 'http://127.0.0.1:18888/v2/chat/completions', body: { model: 'model-b' } });
  await runtime.models.save(ctx, 'main', { ...config, version: rotated.version, apiKey: 'test-key-one', enabled: false });
  expect((await send()).status).toBe('failed'); expect(requests).toHaveLength(2);
});

it('HTTP 管理接口校验登录、CSRF、权限，连接测试不泄露服务端错误正文', async () => {
  const server = createServer({ domain, urls: env.urls, logger: false, admin: false }); await server.ready();
  try {
    expect((await server.app.inject('/api/ai/admin/models')).statusCode).toBe(401);
    const sid = randomUUID();
    await env.kernel.app.insertInto('sys.session').values({ id: createHash('sha256').update(sid).digest('hex'), tenant_id: env.tenantId, user_id: manager.id, expires_at: new Date(Date.now() + 60_000) }).execute();
    const csrf = await server.app.inject('/auth/csrf');
    const headers = { cookie: `cage_sid=${sid}; ${csrf.cookies.map(c => `${c.name}=${c.value}`).join('; ')}`, 'x-csrf-token': csrf.json().token };
    const list = await server.app.inject({ url: '/api/ai/admin/models', headers }); expect(list.statusCode).toBe(200);
    const input = { ...config, version: list.json()[0].version };
    expect((await server.app.inject({ method: 'POST', url: '/api/ai/admin/models/main', headers: { cookie: `cage_sid=${sid}` }, payload: input })).statusCode).toBe(403);
    const saved = await server.app.inject({ method: 'POST', url: '/api/ai/admin/models/main', headers, payload: input }); expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain(config.apiKey);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`credential: ${config.apiKey}`, { status: 401 }));
    const tested = await server.app.inject({ method: 'POST', url: '/api/ai/admin/models/main/test', headers, payload: {} });
    expect(tested.json()).toMatchObject({ ok: false, code: 'HTTP_401' }); expect(tested.body).not.toContain(config.apiKey);
    await env.kernel.app.updateTable('sys.session').set({ user_id: user.id }).where('id', '=', createHash('sha256').update(sid).digest('hex')).execute();
    expect((await server.app.inject({ url: '/api/ai/admin/models', headers })).statusCode).toBe(403);
  } finally { await server.close(); }
});

it('真实模型阶段独立于 ERP fake，模型 fake 没有外呼', async () => {
  const previous = process.env.CAGE_STAGE; process.env.CAGE_STAGE = 'fake';
  try {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => stream());
    const request = { messages: [], tools: [], maxOutputTokens: 32, signal: AbortSignal.timeout(1000) };
    expect((await chatModel('independent', { model: 'test', hosts: { test: 'model.example.invalid' }, environment: 'test' }).generate(request)).text).toBe('OK');
    await expect(chatModel('default-fake', { model: 'test', hosts: { test: 'model.example.invalid' } }).generate(request)).rejects.toThrow('fake');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { if (previous === undefined) delete process.env.CAGE_STAGE; else process.env.CAGE_STAGE = previous; }
});

it('窗口与协议配置校验，Responses 压缩为显式能力，切回 Chat 清除压缩和接续', async () => {
  const service = intelligence.service(env.kernel).models, ctx = await manager.ctx(), [current] = await service.list(ctx);
  await expect(service.save(ctx, 'main', { ...config, version: current.version, contextWindowTokens: 500 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.save(ctx, 'main', { ...config, version: current.version, apiFormat: 'chat-completions', responsesCompaction: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const response = await service.save(ctx, 'main', { ...config, version: current.version, apiFormat: 'responses', contextWindowTokens: 100_000, responsesCompaction: true });
  expect((await service.resolve(ctx.tenantId, 'main')).continuation).toMatchObject({ compaction: true });
  const chat = await service.save(ctx, 'main', { ...config, version: response.version, apiFormat: 'chat-completions' });
  expect(chat).toMatchObject({ contextWindowTokens: 100_000, responsesCompaction: false });
  expect((await service.resolve(ctx.tenantId, 'main')).continuation).toBeUndefined();
});
