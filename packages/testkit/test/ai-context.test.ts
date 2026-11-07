import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as admin from '@yss123/cage-admin/domain';
import { aggregate, command, int, ref, scope, states, text } from '@yss123/cage-kernel';
import { ai, AiRuntime, managedModel } from '@yss123/cage-ai';
import { readContext } from '../../ai/src/context-read.js';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

const Record = aggregate('EvidenceRecord', { fields: { createdBy: ref('User'), reason: text(50_000), count: int() }, states: states('draft'), scope: scope.self('createdBy') });
const create = command(Record, { name: 'create', from: 'new', to: 'draft', input: z.object({ reason: z.string(), count: z.number().int() }), handler: o => o });
const operations = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`update${i}`, command(Record, {
  name: `update${i}`, from: 'draft', to: null, description: i === 11 ? '登记核验标记' : `更新第 ${i} 个标记`,
  input: z.object({ id: z.uuid(), code: z.enum(['A', 'B']), reason: z.string().min(15) }), handler: o => ({ ...o, count: o.count + 1 }),
})]));
const intelligence = ai({ models: { main: managedModel('main') }, context: { maxToolTokens: 6500, maxTools: 20 }, assistant: { model: 'main', limits: { maxSteps: 12 } } });
const domain = { ...admin, Record, create, ...operations, intelligence };
let env: TestEnv, runtime: AiRuntime, user: TestUser, other: TestUser, manager: TestUser;
const config = { version: 0, label: 'Responses 测试', baseUrl: 'https://models.example.invalid/v1/responses', model: 'test', apiKey: 'test-only', enabled: true,
  timeoutMs: 1000, apiFormat: 'responses', contextWindowTokens: 32768, responsesCompaction: false };
beforeAll(async () => {
  vi.stubEnv('CAGE_AI_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  env = await createTestEnv({ domain }); runtime = intelligence.service(env.kernel);
  const caps = ['Sys.ai.use', 'EvidenceRecord.read', 'EvidenceRecord.create', ...Object.keys(operations).map(name => `EvidenceRecord.${name}`)];
  user = await env.user({ caps }); other = await env.user({ caps }); manager = await env.user({ caps: ['Sys.ai.models.manage'] });
  await runtime.models.save(await manager.ctx(), 'main', config);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await runtime?.close(); await env?.close(); vi.unstubAllEnvs(); });
const call = (name: string, args: unknown, callId = randomUUID()) => ({ type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args) });
const message = (value: string) => ({ type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] });
const response = (output: unknown[], id = `resp_${randomUUID()}`) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
  id, status: 'completed', output, usage: { input_tokens: 500, output_tokens: 50 },
} })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const mock = (fn: (body: any, index: number) => Response | Promise<Response>) => {
  const requests: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://models.example.invalid/v1/responses');
    const body = JSON.parse(String(init?.body)); requests.push(body); return fn(body, requests.length);
  });
  return requests;
};
const savedRun = async (id: string) => (await env.query('select * from sys.ai_run where id=$1', [id]))[0];
const complete = async (id: string, service = runtime, who = user) => {
  await service.tick(); const result = await service.run(await who.ctx(), id);
  expect(result.status, JSON.stringify(result)).toBe('succeeded'); return result;
};

it('搜索一次即加载完整工具，回执后重启保留参数校验和写入确认', async () => {
  const ctx = await user.ctx(), session = await runtime.createSession(ctx);
  const record = await env.kernel.execute('EvidenceRecord.create', { reason: '初始材料', count: 0 }, ctx);
  let target = '';
  const requests = mock((body, index) => {
    if (index === 1) {
      expect(body.tools.some((t: any) => t.name === 'tool_search')).toBe(true);
      return response([call('tool_search', { query: '核验标记' })], 'resp_search');
    }
    if (index === 2) {
      expect(body.previous_response_id).toBe('resp_search'); expect(body.input).toHaveLength(1);
      const result = JSON.parse(body.input[0].output); expect(result.items[0].key).toBe('command:EvidenceRecord.update11');
      expect(JSON.stringify(result)).not.toContain('minLength');
      expect(result.loaded).toContain('command:EvidenceRecord.update11');
      const tool = body.tools.find((t: any) => t.description.startsWith('EvidenceRecord.update11:')); target = tool.name;
      expect(tool.parameters.properties.input.properties.code.enum).toEqual(['A', 'B']);
      expect(tool.parameters.properties.input.properties.reason.minLength).toBe(15);
      return response([call(target, { input: { id: record.id, code: 'X', reason: '短' }, expectedVersion: record.version })]);
    }
    if (index === 3) {
      expect(body.input[0].output).toContain('INVALID_INPUT');
      return response([call(target, { input: { id: record.id, code: 'A', reason: '已经按照登记规则完整核验所有材料' }, expectedVersion: record.version })], 'resp_write');
    }
    expect(index).toBe(4); expect(body.previous_response_id).toBe('resp_write');
    expect(JSON.parse(body.input[0].output).count).toBe(1); return response([message('已登记，依据命令回执。')]);
  });
  // 模拟工具选择事务已提交、Observation 尚未提交时 worker 停机。
  const stop = new AbortController(), observe = (runtime as any).observe.bind(runtime);
  const spy = vi.spyOn(runtime as any, 'observe').mockImplementation(async (...args: any[]) => {
    if (args[1].name === 'tool_search') { stop.abort(); throw stop.signal.reason; }
    return observe(...args);
  });
  const run = await runtime.submit(ctx, session.id, { message: '帮我核验当前对象' }, randomUUID());
  await runtime.tick(stop.signal); spy.mockRestore();
  const saved = await savedRun(run.id); expect(saved.status, saved.error).toBe('queued'); expect(saved.tool_keys).toContain('command:EvidenceRecord.update11');
  const restarted = new AiRuntime(env.kernel, runtime.options);
  try {
    await restarted.tick(); const waiting = await restarted.run(ctx, run.id);
    expect(waiting.status, JSON.stringify(waiting)).toBe('waiting_confirmation');
    expect((await env.kernel.read.get(Record, record.id, ctx)).count).toBe(0);
    await restarted.respond(ctx, run.id, waiting.interactions[0].id, { approved: true }); await complete(run.id, restarted);
    expect((await env.kernel.read.get(Record, record.id, ctx)).count).toBe(1); expect(requests).toHaveLength(4);
  } finally { await restarted.close(); }
});

it('Responses 跨轮只传新增消息，性格和页面更新重发指令；改模型版本与授权后断开旧链', async () => {
  const owner = await env.user({ caps: ['Sys.ai.use', 'EvidenceRecord.read'] }), ctx = await owner.ctx(), session = await runtime.createSession(ctx);
  const requests = mock((_body, index) => response([message('已了解')], `resp_round_${index}`));
  const send = async (text: string, title: string, current = ctx) => {
    const run = await runtime.submit(current, session.id, { message: text, pageContext: { pageInstanceId: randomUUID(), revision: 1, capturedAt: new Date().toISOString(), page: { id: 'test', title, kind: 'list', route: '/records' } } }, randomUUID());
    await complete(run.id, runtime, { ...owner, ctx: async () => current }); return run;
  };
  await send('第一轮', '页面甲');
  await runtime.selectPersonality(ctx, session.id, { version: 0, key: 'teacher' });
  await send('第二轮', '页面乙');
  expect(requests[1]).toMatchObject({ previous_response_id: 'resp_round_1', input: [{ role: 'user', content: '第二轮' }] });
  expect(requests[1].input).toHaveLength(1); expect(requests[1].instructions).toContain('页面乙'); expect(requests[1].instructions).not.toBe(requests[0].instructions);
  const adminCtx = await manager.ctx(), [current] = await runtime.models.list(adminCtx);
  // 老客户端省略新增字段时不能把 Responses / 窗口配置重置掉。
  const changed = await runtime.models.save(adminCtx, 'main', { version: current.version, label: current.label, baseUrl: current.baseUrl, model: 'test-v2', enabled: true, timeoutMs: 1000 });
  expect(changed.apiFormat).toBe('responses'); expect(changed.contextWindowTokens).toBe(32768);
  await send('第三轮', '页面丙'); expect(requests[2].previous_response_id).toBeUndefined();
  await env.kernel.execute('Role.grantCapability', { id: owner.roleId, capability: 'EvidenceRecord.create' }, env.system());
  await send('第四轮', '页面丁', await owner.ctx());
  expect(requests[3].previous_response_id).toBeUndefined(); expect(requests[3].input).toEqual([{ role: 'user', content: '第四轮' }]);
  const strangerCtx = await other.ctx(), strangerSession = await runtime.createSession(strangerCtx);
  const strangerRun = await runtime.submit(strangerCtx, strangerSession.id, { message: '其他账号' }, randomUUID()); await complete(strangerRun.id, runtime, other);
  expect(requests[4].previous_response_id).toBeUndefined();
});

it('远端历史失效后从本地恢复工具配对和原始推理项，不再次执行已确认的命令', async () => {
  const ctx = await user.ctx(), session = await runtime.createSession(ctx), record = await env.kernel.execute('EvidenceRecord.create', { reason: '原始记录', count: 0 }, ctx);
  let commandName = '';
  const requests = mock((body, index) => {
    if (index === 1) return response([call('tool_load', { keys: ['command:EvidenceRecord.update11'] })], 'resp_expire_load');
    if (index === 2) {
      commandName = body.tools.find((t: any) => t.description.startsWith('EvidenceRecord.update11:')).name;
      return response([{ type: 'reasoning', id: 'rs_original', summary: [], encrypted_content: 'encrypted-test-only' },
        call(commandName, { input: { id: record.id, code: 'A', reason: '已经完整核验登记材料并确认符合规定' }, expectedVersion: record.version }, 'call_original')], 'resp_expire_write');
    }
    if (index === 3) { expect(body.previous_response_id).toBe('resp_expire_write'); return new Response('', { status: 404 }); }
    expect(index).toBe(4); expect(body.previous_response_id).toBeUndefined();
    expect(body.input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-test-only' }));
    expect(body.input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_original', name: commandName }));
    const receipt = body.input.find((i: any) => i.type === 'function_call_output' && i.call_id === 'call_original');
    expect(JSON.parse(receipt.output).count).toBe(1); return response([message('恢复后确认登记已完成')]);
  });
  const run = await runtime.submit(ctx, session.id, { message: '登记标记' }, randomUUID()); await runtime.tick();
  const waiting = await runtime.run(ctx, run.id); expect(waiting.status, JSON.stringify(waiting)).toBe('waiting_confirmation');
  await runtime.respond(ctx, run.id, waiting.interactions[0].id, { approved: true }); await complete(run.id);
  expect((await env.kernel.read.get(Record, record.id, ctx)).count).toBe(1); expect(requests).toHaveLength(4);
  expect((await runtime.events(ctx, run.id)).some(e => (e.data as any).reason === 'remote_history_expired')).toBe(true);
});

it('大型证据只收起模型视图，完整文本可沿回执取回，不能跨会话、用户、授权或审批边界读取', async () => {
  const ctx = await user.ctx(), session = await runtime.createSession(ctx), reason = '原始证据内容'.repeat(4000) + ' EXACT-END-917';
  const record = await env.kernel.execute('EvidenceRecord.create', { reason, count: 0 }, ctx);
  const requests = mock((body, index) => {
    if (index === 1) return response([call('data_get', { aggregate: Record.name, id: record.id })]);
    if (index === 2) {
      const output = JSON.parse(body.input[0].output); expect(output.truncated).toBe(true); expect(body.input[0].output.length).toBeLessThan(12_000);
      return response([call('context_read', { source: 'action', ref: output.ref.actionId, path: ['reason'], offset: reason.length - 30 })]);
    }
    expect(body.input[0].output).toContain('EXACT-END-917'); return response([message('已经取到原文末尾 EXACT-END-917')]);
  });
  const run = await runtime.submit(ctx, session.id, { message: '核对完整证据' }, randomUUID()); await complete(run.id); expect(requests).toHaveLength(3);
  const [action] = await env.query("select id, result from sys.ai_action where run_id=$1 and tool='data_get'", [run.id]); expect(action.result.reason).toBe(reason);
  const next = await runtime.submit(ctx, session.id, { message: '下一轮' }, randomUUID());
  const execution = { kernel: env.kernel, ctx, ontology: runtime.ontology, run: await savedRun(next.id), signal: new AbortController().signal };
  const input = { source: 'action' as const, runId: run.id, ref: action.id, path: ['reason'], offset: reason.length - 30, limit: 10 };
  expect(await readContext(execution, input)).toMatchObject({ text: expect.stringContaining('EXACT-END-917'), nextOffset: null });
  for (const modified of [{ session_id: randomUUID() }, { user_id: other.id }, { tenant_id: randomUUID() }, { auth_fingerprint: 'revoked' }, { fingerprint: 'old-registry' }, { mode: 'approval' }])
    await expect(readContext({ ...execution, run: { ...execution.run, ...modified } }, input)).rejects.toHaveProperty('code');
  await runtime.cancel(ctx, next.id);
});
