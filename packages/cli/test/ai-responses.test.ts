import { afterEach, expect, it, vi } from 'vitest';
import { responsesModel, ResponseHistoryExpired } from '../../ai/src/responses.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const message = (text: string) => ({ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const completed = (output: unknown[], id = 'resp-1') => ({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20 } } });

it('Responses 按原生协议流式交付文字，保留 call_id、完整参数、用量和不透明推理项', async () => {
  vi.stubEnv('CAGE_STAGE', 'test');
  const reasoning = { type: 'reasoning', id: 'rs-1', summary: [], encrypted_content: 'opaque-test-only' };
  const fetcher = vi.fn(async () => sse([
    { type: 'response.created', response: { id: 'resp-1' } },
    { type: 'response.output_text.delta', delta: '正在核对' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: '{"id":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: '"target"}' },
    completed([reasoning, message('正在核对'), { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'lookup', arguments: '{"id":"target"}' }]),
  ]));
  vi.stubGlobal('fetch', fetcher);
  const provider = responsesModel('native', { model: 'test-model', hosts: { test: 'api.example.invalid' } });
  const chunks: string[] = [];
  const result = await provider.generate({ messages: [{ role: 'system', content: '必须遵守当前规则' }, { role: 'user', content: '查一下' }],
    tools: [{ name: 'lookup', description: '查询', input: { type: 'object', properties: { id: { type: 'string' }, optional: { type: 'string' } }, required: ['id'] } }],
    maxOutputTokens: 100, signal: new AbortController().signal, onText: async text => { chunks.push(text); }, context: { tenantId: 'secret-tenant', runId: 'secret-run' } });
  expect(chunks).toEqual(['正在核对']); expect(result).toMatchObject({ text: '正在核对', responseId: 'resp-1', calls: [{ id: 'call-1', name: 'lookup', arguments: { id: 'target' } }], usage: { inputTokens: 100, outputTokens: 20 } });
  expect(result.outputItems).toContainEqual(reasoning);
  const [url, init] = (fetcher.mock.calls as any)[0], body = JSON.parse(init.body);
  expect(String(url)).toBe('https://api.example.invalid/v1/responses'); expect(init.redirect).toBe('error');
  expect(body).toMatchObject({ instructions: '必须遵守当前规则', store: true, truncation: 'disabled', max_output_tokens: 100,
    tools: [{ type: 'function', strict: false, parameters: { required: ['id'] } }] });
  expect(JSON.stringify(body)).not.toContain('secret-tenant'); expect(body.context_management).toBeUndefined(); expect(body.messages).toBeUndefined();
});

it('Responses 接续只发送新增工具结果，并重发当前指令；服务端压缩必须显式启用', async () => {
  vi.stubEnv('CAGE_STAGE', 'test'); let body: any;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { body = JSON.parse(String(init.body)); return sse([completed([message('完成')])]); }));
  const provider = responsesModel('continuation', { model: 'test', hosts: { test: 'api.example.invalid' }, contextWindowTokens: 100_000, compaction: true });
  await provider.generate({ previousResponseId: 'resp-previous', stateKey: provider.continuation!.key,
    messages: [{ role: 'system', content: '新的性格和当前页面' }, { role: 'tool', toolCallId: 'call-old', content: '{"ok":true}' }], tools: [], maxOutputTokens: 500, signal: new AbortController().signal });
  expect(body).toMatchObject({ previous_response_id: 'resp-previous', instructions: '新的性格和当前页面',
    input: [{ type: 'function_call_output', call_id: 'call-old', output: '{"ok":true}' }], context_management: [{ type: 'compaction', compact_threshold: 60_000 }] });
  expect(body.input).toHaveLength(1);
});

it('真实 SSE 未结束时 onText 已到达，半截/失败响应绝不交付可执行工具', async () => {
  vi.stubEnv('CAGE_STAGE', 'test'); let stream!: ReadableStreamDefaultController<Uint8Array>, delivered!: () => void, finished = false;
  const first = new Promise<void>(resolve => { delivered = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    stream = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"首段"}\n\n'));
  } }), { headers: { 'content-type': 'text/event-stream' } })));
  const provider = responsesModel('stream', { model: 'test', hosts: { test: 'api.example.invalid' } });
  const request = { messages: [], tools: [], maxOutputTokens: 100, signal: new AbortController().signal };
  const pending = provider.generate({ ...request, onText: async () => { delivered(); } }).then(result => { finished = true; return result; });
  await first; expect(finished).toBe(false);
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(completed([message('首段')]))}\n\n`)); stream.close();
  expect((await pending).text).toBe('首段');
  vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'response.output_text.delta', delta: '未完成' }])));
  await expect(provider.generate(request)).rejects.toThrow('AI_MODEL_INCOMPLETE');
  vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'response.failed', response: { status: 'failed', output: [] } }])));
  await expect(provider.generate(request)).rejects.toThrow('AI_MODEL_UPSTREAM_ERROR');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  await expect(provider.generate({ ...request, previousResponseId: 'expired' })).rejects.toBeInstanceOf(ResponseHistoryExpired);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'previous_response_id requires an OpenAI API-key account for HTTP requests' }), { status: 400, headers: { 'content-type': 'application/json' } })));
  await expect(provider.generate({ ...request, previousResponseId: 'unsupported' })).rejects.toBeInstanceOf(ResponseHistoryExpired);
});
