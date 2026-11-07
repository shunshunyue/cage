import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import * as admin from '@yss123/cage-admin/domain';
import { ai, type AiRuntime, type ModelRequest, type ModelResult } from '@yss123/cage-ai';
import { createServer } from '@yss123/cage-http';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

let model: (request: ModelRequest) => Promise<ModelResult> | ModelResult = () => ({ text: '你好', calls: [] });
const intelligence = ai({ models: { main: { spec: { kind: 'personality-test' }, generate: request => Promise.resolve(model(request)) } }, assistant: { model: 'main', instructions: '应用规则：使用已提供的能力。' } });
const domain = { ...admin, intelligence };
const input = { version: 0, label: '测试搭档', avatar: '🌱', description: '语气温和，先讲结论。', verbosity: 'concise' as const,
  address: '朋友', emoji: 'light' as const, examples: ['我来帮你理清楚。'], enabled: true };
let env: TestEnv, manager: TestUser, user: TestUser, other: TestUser, runtime: AiRuntime;
beforeAll(async () => {
  env = await createTestEnv({ domain }); runtime = intelligence.service(env.kernel);
  manager = await env.user({ caps: ['Sys.ai.personalities.manage'] });
  user = await env.user({ caps: ['Sys.ai.use'] }); other = await env.user({ caps: ['Sys.ai.use'] });
});
beforeEach(() => { model = () => ({ text: '你好', calls: [] }); });
afterAll(async () => { await runtime?.close(); await env?.close(); });

it('预设可直接使用；管理独立授权，租户配置和内部描述不泄露给普通用户', async () => {
  const ctx = await manager.ctx(), service = runtime.personalities;
  await expect(service.list(await user.ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(service.available(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect((await service.list(ctx)).items).toHaveLength(6);
  await service.save(ctx, 'team-custom', { ...input, description: '租户内部风格标记' });
  const available = await service.available(await user.ctx());
  expect(available.defaultKey).toBe('partner'); expect(available.items).toHaveLength(7);
  expect(JSON.stringify(available)).not.toContain('租户内部风格标记');
  expect((await service.list({ ...ctx, tenantId: randomUUID() })).items).toHaveLength(6);
  const [audit] = await env.audit({ command: 'Sys.ai.personalities.save' });
  expect(audit.diff.after.key).toBe('team-custom');
  await expect(service.save(ctx, 'injected', { ...input, confirmWrites: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('配置并发更新有版本校验，默认项不能停用，也不能选未启用的默认项', async () => {
  const ctx = await manager.ctx(), service = runtime.personalities;
  const competing = await Promise.allSettled([1, 2].map(() => service.save(ctx, 'concurrent', input)));
  expect(competing.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(competing.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
  const settings = await service.saveSettings(ctx, { version: 0, defaultKey: 'concurrent' });
  await expect(service.saveSettings(ctx, { version: 0, defaultKey: 'partner' })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(service.save(ctx, 'concurrent', { ...input, version: 1, enabled: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await service.save(ctx, 'disabled', { ...input, enabled: false });
  await expect(service.saveSettings(ctx, { ...settings, defaultKey: 'disabled' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await service.saveSettings(ctx, { ...settings, defaultKey: 'partner' });
  expect((await service.available(await user.ctx())).items.some(p => p.key === 'disabled')).toBe(false);
});

it('每条消息冻结性格版本，切换保留会话；重试不被新性格替换', async () => {
  const ctx = await user.ctx(), service = runtime.personalities, managerCtx = await manager.ctx();
  await service.save(managerCtx, 'snapshot', { ...input, description: '原始性格标记' });
  const session = await runtime.createSession(ctx, '持续对话', 'snapshot'), key = randomUUID();
  const first = await runtime.submit(ctx, session.id, { message: '第一条' }, key);
  await service.save(managerCtx, 'snapshot', { ...input, version: 1, description: '修改后的性格标记' });
  const selected = await runtime.selectPersonality(ctx, session.id, { key: 'minimalist', version: 0 });
  expect(selected.id).toBe(session.id);
  const repeated = await runtime.submit(ctx, session.id, { message: '第一条' }, key);
  expect(repeated).toMatchObject({ id: first.id, personality: { key: 'snapshot', version: 1 } });
  let captured!: ModelRequest; model = req => { captured = req; return { text: '第一条完成', calls: [] }; };
  await runtime.tick();
  expect(captured.messages[0].content).toContain('原始性格标记');
  expect(captured.messages[0].content).not.toContain('修改后的性格标记');
  expect(captured.messages[0].content).toContain('应用规则');
  const second = await runtime.submit(ctx, session.id, { message: '第二条' }, randomUUID());
  await runtime.tick();
  expect(second.personality?.key).toBe('minimalist');
  expect(captured.messages.some(m => m.content === '第一条完成')).toBe(true);
  expect((await runtime.runs(ctx, session.id))).toHaveLength(2);
  await expect(runtime.selectPersonality(await other.ctx(), session.id, { key: null, version: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(runtime.selectPersonality(ctx, session.id, { key: null, version: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(runtime.selectPersonality(ctx, session.id, { key: 'disabled', version: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('发送与切换遵守同一锁顺序，旧会话和跟随默认的会话可使用新配置', async () => {
  const ctx = await user.ctx(), service = runtime.personalities;
  const legacyId = randomUUID();
  await env.query('insert into sys.ai_session (id, tenant_id, user_id, title) values ($1,$2,$3,$4)', [legacyId, ctx.tenantId, ctx.userId, '旧会话']);
  const settings = (await service.list(await manager.ctx())).settings;
  const next = await service.saveSettings(await manager.ctx(), { ...settings, defaultKey: 'teacher' });
  const run = await runtime.submit(ctx, legacyId, { message: '默认性格' }, randomUUID());
  expect(run.personality?.key).toBe('teacher'); await runtime.tick();
  const results = await Promise.allSettled([
    runtime.submit(ctx, legacyId, { message: '并发发送' }, randomUUID()),
    runtime.selectPersonality(ctx, legacyId, { key: 'detective', version: 0 }),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  await runtime.tick(); await service.saveSettings(await manager.ctx(), { ...next, defaultKey: 'partner' });
});

it('试聊使用未保存草稿且流式交付，不提供业务工具、历史或记忆，也不持久化草稿', async () => {
  const ctx = await manager.ctx(); let captured!: ModelRequest, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  model = async req => { captured = req; await req.onText?.('先看到这段'); entered(); await blocked; return { text: '先看到这段，已完成。', calls: [] }; };
  const chunks: string[] = [];
  const before = await runtime.personalities.list(ctx);
  const preview = runtime.previewPersonality(ctx, { profile: { ...input, version: undefined }, message: '试聊输入标记' }, async text => { chunks.push(text); });
  // 输入仅允许表达字段，版本属于持久化管理协议。
  await expect(preview).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const { version: _version, ...profile } = input;
  const running = runtime.previewPersonality(ctx, { profile, message: '试聊输入标记' }, async text => { chunks.push(text); });
  await started;
  expect(chunks.join('')).toBe('先看到这段'); expect(captured.tools).toEqual([]); expect(captured.messages).toHaveLength(2);
  await expect(runtime.previewPersonality(ctx, { profile, message: '重复' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  release(); expect((await running).text).toBe('先看到这段，已完成。');
  expect(await runtime.personalities.list(ctx)).toEqual(before);
  expect(JSON.stringify(await env.audit({ command: 'Sys.ai.personalities.preview' }))).not.toContain('试聊输入标记');
});

it('试聊取消会终止等待，不接受未授权的调用', async () => {
  const { version: _version, ...profile } = input, ctx = await manager.ctx();
  await expect(runtime.previewPersonality(await user.ctx(), { profile, message: '你好' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  model = () => { entered(); return new Promise<ModelResult>(() => {}); };
  const controller = new AbortController(), pending = runtime.previewPersonality(ctx, { profile, message: '取消' }, undefined, controller.signal);
  await started; controller.abort(new Error('preview-cancelled'));
  await expect(pending).rejects.toThrow('preview-cancelled');
  model = () => ({ text: '可再次试聊', calls: [] });
  expect((await runtime.previewPersonality(ctx, { profile, message: '重新试聊' })).text).toBe('可再次试聊');
});

it('HTTP 校验登录、CSRF 与独立管理权限，公开接口只列可用性格', async () => {
  const server = createServer({ domain, urls: env.urls, admin: false, logger: false }); await server.ready();
  try {
    expect((await server.app.inject('/api/ai/admin/personalities')).statusCode).toBe(401);
    const sid = randomUUID(), hash = createHash('sha256').update(sid).digest('hex');
    await env.kernel.app.insertInto('sys.session').values({ id: hash, tenant_id: env.tenantId, user_id: manager.id, expires_at: new Date(Date.now() + 60_000) }).execute();
    const csrf = await server.app.inject('/auth/csrf');
    const headers = { cookie: `cage_sid=${sid}; ${csrf.cookies.map(c => `${c.name}=${c.value}`).join('; ')}`, 'x-csrf-token': csrf.json().token };
    expect((await server.app.inject({ url: '/api/ai/admin/personalities', headers })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'POST', url: '/api/ai/admin/personalities/http-test', headers: { cookie: `cage_sid=${sid}` }, payload: input })).statusCode).toBe(403);
    expect((await server.app.inject({ method: 'POST', url: '/api/ai/admin/personalities/http-test', headers, payload: input })).statusCode).toBe(200);
    const { version: _version, ...profile } = input;
    expect((await server.app.inject({ method: 'POST', url: '/api/ai/admin/personality-preview', headers, payload: { profile, message: '你好' } })).json()).toMatchObject({ text: '你好' });
    await env.kernel.app.updateTable('sys.session').set({ user_id: user.id }).where('id', '=', hash).execute();
    expect((await server.app.inject({ url: '/api/ai/admin/personalities', headers })).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/ai/personalities', headers })).json().items.some((p: any) => p.key === 'http-test')).toBe(true);
  } finally { await server.close(); }
});

it('试聊 HTTP SSE 在模型完成前发送增量，结束事件包含完整回复', async () => {
  let finish!: () => void, completed = false;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  model = async request => {
    await request.onText?.('先到达'); await blocked; completed = true;
    return { text: '先到达，然后完成。', calls: [] };
  };
  const server = createServer({ domain, urls: env.urls, admin: false, logger: false });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const sid = randomUUID(), hash = createHash('sha256').update(sid).digest('hex');
    await env.kernel.app.insertInto('sys.session').values({ id: hash, tenant_id: env.tenantId, user_id: manager.id, expires_at: new Date(Date.now() + 60_000) }).execute();
    const csrf = await server.app.inject('/auth/csrf'), { version: _version, ...profile } = input;
    const response = await fetch(`${url}/api/ai/admin/personality-preview`, { method: 'POST', signal: AbortSignal.timeout(8_000),
      headers: { cookie: `cage_sid=${sid}; ${csrf.cookies.map(c => `${c.name}=${c.value}`).join('; ')}`, 'x-csrf-token': csrf.json().token,
        'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ profile, message: '试聊' }) });
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events: any[] = [];
    const readUntil = async (done: () => boolean) => {
      while (!done()) {
        const chunk = await reader!.read(); if (chunk.done) throw new Error('试聊过早结束');
        buffer += decoder.decode(chunk.value, { stream: true }); let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find(line => line.startsWith('data: ')); if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    };
    await readUntil(() => events.some(e => e.type === 'delta'));
    expect(completed).toBe(false); expect(events[0]).toEqual({ type: 'delta', text: '先到达' });
    finish(); await readUntil(() => events.some(e => e.type === 'done'));
    expect(events.at(-1)).toMatchObject({ type: 'done', result: { text: '先到达，然后完成。' } });
  } finally { finish(); await reader?.cancel(); reader?.releaseLock(); await server.close(); }
});
