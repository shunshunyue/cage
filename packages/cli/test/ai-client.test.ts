import { afterEach, expect, it, vi } from 'vitest';
import { AiPageContext, CageClient } from '../../client/src/index.js';
import { applyStreamEvent, streamState } from '../../client/src/ai-stream.js';
import type { AiEvent, AiRun } from '@yss123/cage-ai-protocol';
import { chatModel } from '../../ai/src/model.js';
import { ai } from '../../ai/src/index.js';
import { aggregate, approval, buildRegistry, command, event, states, text } from '@yss123/cage-kernel';
import { route, step, approver } from '../../approval/src/route.js';
import { extract } from '../src/ontology.js';
import { projectGraph } from '../src/graph-model.js';
import { approvalFlowForStep } from '../src/graph-approvals.js';
import { runtimeOntology } from '@yss123/cage-ontology';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  for (const part of chunks) controller.enqueue(new TextEncoder().encode(part)); controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

it('SDK 支持旧会话标题、新建时选性格，并以同一会话和版本切换', async () => {
  const requests: { path: string; body: any; headers: any }[] = [];
  const client = new CageClient({ fetch: (async (url, options) => {
    if (String(url).endsWith('/auth/csrf')) return json({ token: 'csrf' });
    requests.push({ path: String(url), body: options?.body ? JSON.parse(String(options.body)) : null, headers: options?.headers });
    return json({ id: 'same-session', personalityKey: 'teacher', personalityVersion: 3 });
  }) as typeof fetch });
  await client.ai.createSession('旧标题');
  await client.ai.createSession({ title: '新会话', personalityKey: 'minimalist' });
  await client.ai.selectPersonality('same-session', { key: 'teacher', version: 2 });
  await client.ai.selectPersonality('same-session', { key: null, version: 3 });
  expect(requests.map(r => [r.path, r.body])).toEqual([
    ['/api/ai/sessions', { title: '旧标题' }], ['/api/ai/sessions', { title: '新会话', personalityKey: 'minimalist' }],
    ['/api/ai/sessions/same-session/personality', { key: 'teacher', version: 2 }], ['/api/ai/sessions/same-session/personality', { key: null, version: 3 }],
  ]);
  expect(requests.every(r => r.headers['x-csrf-token'] === 'csrf')).toBe(true);
});

it('SDK 将公开性格目录与管理配置分开，未保存的草稿可单独试聊', async () => {
  const requests: { path: string; method: string; body: any }[] = [];
  const client = new CageClient({ fetch: (async (url, options) => {
    if (String(url).endsWith('/auth/csrf')) return json({ token: 'csrf' });
    requests.push({ path: String(url), method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : null });
    return json({ text: '预览文字', latencyMs: 100 });
  }) as typeof fetch });
  const profile = { label: '自定义', avatar: '✨', description: '先讲结论', verbosity: 'concise' as const, address: '', emoji: 'none' as const, examples: [], enabled: true };
  await client.ai.personalities(); await client.ai.personalitySettings();
  await client.ai.savePersonality('team', { ...profile, version: 1 });
  await client.ai.savePersonalitySettings({ version: 2, defaultKey: 'team' });
  const result = await client.ai.previewPersonality({ profile, message: '你好' });
  expect(result).toMatchObject({ ok: true, data: { text: '预览文字' } });
  expect(requests.map(r => [r.method, r.path])).toEqual([
    ['GET', '/api/ai/personalities'], ['GET', '/api/ai/admin/personalities'],
    ['POST', '/api/ai/admin/personalities/team'], ['POST', '/api/ai/admin/assistant-settings'], ['POST', '/api/ai/admin/personality-preview'],
  ]);
  expect(requests.at(-1)?.body).toEqual({ profile, message: '你好' });
});

it('页面快照保持发送时内容，每个页面实例独立；SDK 只发送声明的页面协议', async () => {
  const value = { page: { id: 'list', title: '列表', kind: 'list' as const, route: '/documents' }, view: { aggregate: 'Document', input: { status: 'draft' } } };
  const a = new AiPageContext(value), b = new AiPageContext(value), old = a.snapshot();
  value.view.input.status = 'accepted'; a.update(value);
  expect(old.view?.input?.status).toBe('draft'); expect(a.snapshot().revision).toBe(1); expect(b.snapshot().revision).toBe(0);
  expect(a.pageInstanceId).not.toBe(b.pageInstanceId);
  const calls: RequestInit[] = [];
  const client = new CageClient({ fetch: (async (url, options) => {
    if (String(url).endsWith('/auth/csrf')) return json({ token: 'csrf' });
    calls.push(options!); return json({ id: 'run' }, 202);
  }) as typeof fetch });
  expect((await client.ai.send('session', { message: '这个页面', pageContext: old }, { idempotencyKey: 'once' })).ok).toBe(true);
  expect(JSON.parse(calls[0].body as string).pageContext).toEqual(old);
  expect(calls[0].headers).toMatchObject({ 'idempotency-key': 'once', 'x-csrf-token': 'csrf' });
});

it('SDK 解析跨块 SSE、去掉重复序号，并在终态补取断线时提交的事件', async () => {
  const one = { runId: 'run', sequence: 1, type: 'message.delta', data: { text: '你好' }, createdAt: new Date().toISOString() };
  const two = { ...one, sequence: 2, type: 'message.completed' };
  const block = `id: 1\nevent: message.delta\ndata: ${JSON.stringify(one)}\n\n`;
  const client = new CageClient({ fetch: (async (url, options) => {
    if ((options?.headers as any)?.accept) return sse([block.slice(0, 30), block.slice(30), block]);
    if (String(url).includes('/events')) return json([two]);
    return json({ id: 'run', status: 'succeeded', answer: '你好' });
  }) as typeof fetch });
  const events: number[] = [];
  expect((await client.ai.watch('run', e => events.push(e.sequence))).status).toBe('succeeded');
  expect(events).toEqual([1, 2]);
});

it('SDK 在 SSE 尚未结束时就交付文字，不等待最终回答', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>, notify!: () => void, finished = false;
  const received = new Promise<void>(resolve => { notify = resolve; });
  const event = { runId: 'run', sequence: 1, type: 'message.delta', data: { step: 1, text: '先看到这段' }, createdAt: new Date().toISOString() };
  const client = new CageClient({ fetch: (async (url, options) => {
    if ((options?.headers as any)?.accept) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    if (String(url).includes('/events')) return json([]);
    return json({ id: 'run', status: 'succeeded', answer: '先看到这段，再看到后续' });
  }) as typeof fetch });
  const delivered: AiEvent[] = [];
  const watching = client.ai.watch('run', event => { delivered.push(event); notify(); }).then(run => { finished = true; return run; });
  try {
    await received;
    expect(finished).toBe(false); expect(delivered[0].data).toMatchObject({ text: '先看到这段' });
  } finally { stream.close(); }
  expect((await watching).answer).toContain('后续');
});

it('SDK 实时更新步骤/工具状态，长回复不因事件窗口截断；续传不会重复文字', () => {
  const run: AiRun = { id: 'run', sessionId: 'session', status: 'queued', phase: 'context', answer: null, error: null,
    steps: 0, toolCalls: 0, tokens: 0, interactions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let state = streamState(run), sequence = 0;
  const emit = (type: AiEvent['type'], data: unknown) => {
    const event = { runId: run.id, sequence: ++sequence, type, data, createdAt: run.createdAt };
    state = applyStreamEvent(state, event); return event;
  };
  emit('run.status', { status: 'running' }); emit('model.started', { step: 1 }); emit('message.delta', { step: 1, text: '我先查进度' });
  emit('tool.started', { callId: 'query', tool: 'approval_history' });
  expect(state.progress).toMatchObject({ stage: 'tool', tool: 'approval_history', toolState: 'running' });
  emit('tool.completed', { callId: 'query', tool: 'approval_history', ok: true, toolCalls: 1 });
  expect(state.run?.toolCalls).toBe(1);
  emit('model.started', { step: 2 }); expect(state.text).toBe('');
  for (let index = 0; index < 1100; index++) emit('message.delta', { step: 2, text: '字' });
  const last = emit('message.delta', { step: 2, text: '末尾' });
  state = applyStreamEvent(state, last);
  expect(state.text).toBe('字'.repeat(1100) + '末尾');
  emit('run.status', { status: 'cancelled' });
  expect(state.progress.stage).toBe('done'); expect(state.text).toContain('末尾');
});

it('SSE 的 CRLF 可跨分片，终态读取短暂断网后按序号恢复且不重复交付', async () => {
  const event = { runId: 'run', sequence: 1, type: 'message.completed', data: { text: '完成' }, createdAt: new Date().toISOString() };
  const block = `data: ${JSON.stringify(event)}\r\n\r\n`;
  let stateCalls = 0; const cursors: string[] = [];
  const client = new CageClient({ fetch: (async (url, options) => {
    if ((options?.headers as any)?.accept) {
      cursors.push(String(url));
      return sse([block.slice(0, -3), block.slice(-3, -1), block.slice(-1)]);
    }
    if (String(url).includes('/events')) return json([]);
    if (++stateCalls === 1) throw new TypeError('synthetic offline');
    return json({ id: 'run', status: 'succeeded', answer: '完成' });
  }) as typeof fetch });
  const events: number[] = [];
  expect((await client.ai.watch('run', e => events.push(e.sequence))).status).toBe('succeeded');
  expect(events).toEqual([1]); expect(cursors).toHaveLength(2); expect(cursors[1]).toContain('after=1');
});

it('流式模型外呼只访问白名单，完整拼接分片工具参数并处理结束标记', async () => {
  vi.stubEnv('CAGE_STAGE', 'test');
  const chunks = [
    { choices: [{ delta: { content: '检查中' }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'data_get', arguments: '{"aggregate":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Document","id":"x"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
  ];
  const fetcher = vi.fn(async () => sse(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).concat('data: [DONE]\n\n')));
  vi.stubGlobal('fetch', fetcher);
  const provider = chatModel('test-model', { model: 'script-model', hosts: { test: 'model.example.com' } });
  const deltas: string[] = [];
  const result = await provider.generate({ messages: [{ role: 'user', content: '读取' }], tools: [], signal: new AbortController().signal, maxOutputTokens: 100, onText: async text => { deltas.push(text); } });
  expect(result.calls).toEqual([{ id: 'c1', name: 'data_get', arguments: { aggregate: 'Document', id: 'x' } }]);
  expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8 }); expect(deltas).toEqual(['检查中']);
  expect(String((fetcher.mock.calls as any)[0][0])).toBe('https://model.example.com/v1/chat/completions');
  expect((fetcher.mock.calls as any)[0][1].redirect).toBe('error');
});

it('模型半截响应、错误工具参数和未配置 fake 不会被视为成功裁决', async () => {
  const provider = chatModel('broken-model', { model: 'script-model', hosts: { test: 'model.example.com' } });
  const request = { messages: [], tools: [], signal: new AbortController().signal, maxOutputTokens: 100 };
  vi.stubEnv('CAGE_STAGE', 'fake'); await expect(provider.generate(request)).rejects.toThrow('fake');
  vi.stubEnv('CAGE_STAGE', 'test');
  vi.stubGlobal('fetch', vi.fn(async () => sse(['data: {"choices":[{"delta":{"content":"通过"},"finish_reason":"stop"}]}\n\n'])));
  await expect(provider.generate(request)).rejects.toThrow('AI_MODEL_INCOMPLETE');
  vi.stubGlobal('fetch', vi.fn(async () => sse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"review_decide","arguments":"{"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'])));
  await expect(provider.generate(request)).rejects.toThrow();
});

it('AI 审批进入已有图谱与结论边，运行本体不导出隐藏字段、SQL 或策略提示词', () => {
  const Record = aggregate('AiRecord', { fields: { reason: text(), secret: text().hidden() }, states: states('draft', 'pending', 'accepted', 'rejected') });
  const Submitted = event('AiSubmitted', {});
  const approve = command(Record, { name: 'approve', from: 'pending', to: 'accepted', invokedBy: 'process', handler: o => o });
  const reject = command(Record, { name: 'reject', from: 'pending', to: 'rejected', invokedBy: 'process', handler: o => o });
  const revise = command(Record, { name: 'revise', from: 'pending', to: 'draft', invokedBy: 'process', handler: o => o });
  const review = approval(Record, { process: 'ai-record', start: Submitted, routable: [], onApproved: approve, onRejected: reject, onReturned: revise, automatedBy: 'reviewer' });
  const routed = route('ai-record', [step('智能节点', { kind: 'ai', model: 'main', instructions: 'PRIVATE_POLICY_MARKER', context: { fields: ['reason'] }, handoff: approver.role('reviewer') })]);
  const runtime = ai({ models: { main: { spec: {}, generate: async () => ({ text: '', calls: [] }) } } });
  const registry = buildRegistry({ Record, Submitted, approve, reject, revise, review, routed, runtime }), graph = extract(registry), view = projectGraph(graph);
  expect(graph.edges.some(e => e.kind === 'binds' && e.to === 'AiRecord.revise')).toBe(true);
  const node = view.nodes.find(n => n.kind === 'approval')!;
  const flow = approvalFlowForStep(view, { node, label: '审查' } as any)!;
  expect(flow.groups[0].tasks[0].actor).toBe('AI 审核');
  expect(JSON.stringify(runtimeOntology(registry))).not.toContain('PRIVATE_POLICY_MARKER');
  expect((runtimeOntology(registry).nodes.find(n => n.kind === 'aggregate')!.data.fields as any).secret).toBeUndefined();
});
