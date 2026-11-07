import { afterEach, expect, it, vi } from 'vitest';
import { responsesModel } from '../../ai/src/responses.js';
import { chatModel } from '../../ai/src/model.js';
import { modelFailure } from '../../ai/src/model-failure.js';

afterEach(() => vi.unstubAllGlobals());
const options = { model: 'test', hosts: { test: 'model.example.invalid' }, environment: 'test' as const };
const request = () => ({
  messages: [],
  tools: [],
  maxOutputTokens: 100,
  signal: new AbortController().signal,
});
const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
const secret = 'PRIVATE_RESPONSE_CONTENT';

it.each([
  [
    'output limit',
    {
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' }, output: [] },
    },
    { code: 'AI_MODEL_OUTPUT_LIMIT', reason: 'output_limit', stopReason: 'max_output_tokens' },
  ],
  [
    'upstream error',
    { type: 'response.failed', response: { error: { code: 'server_error', message: secret } } },
    { code: 'AI_MODEL_UPSTREAM_ERROR', reason: 'provider_error', providerCode: 'server_error' },
  ],
  [
    'malformed tool',
    {
      type: 'response.completed',
      response: {
        id: 'r1',
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'c1', name: 'write', arguments: `{${secret}` }],
      },
    },
    { code: 'AI_MODEL_RESPONSE_INVALID', reason: 'invalid_arguments' },
  ],
])('Responses 失败保留 %s 的原因，不暴露正文或返回可执行工具', async (_name, event, expected) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => sse(event)),
  );
  const provider = responsesModel('failure', options);
  const error = await provider.generate(request()).then(
    () => {
      throw new Error('unexpected success');
    },
    (error) => error,
  );
  expect(modelFailure(error)).toMatchObject(expected);
  expect(String(error)).not.toContain(secret);
  expect(JSON.stringify(modelFailure(error))).not.toContain(secret);
});

it('Chat 输出上限与连接器请求超时分别分类', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')),
  );
  const provider = chatModel('chat-failure', { ...options, timeoutMs: 20 });
  await expect(provider.generate(request())).rejects.toThrow('AI_MODEL_OUTPUT_LIMIT');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
    ),
  );
  const error = await provider.generate(request()).catch((error) => error);
  expect(modelFailure(error)).toEqual({ code: 'AI_MODEL_TIMEOUT', reason: 'request_timeout' });
});

it('HTTP 拒绝、网络断开与未知错误保留不同诊断，不拷贝上游消息', async () => {
  const provider = responsesModel('http-failure', options);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'server_error', message: secret } }), { status: 502 }),
    ),
  );
  const error = await provider.generate(request()).catch((error) => error);
  expect(modelFailure(error)).toMatchObject({
    code: 'AI_MODEL_HTTP_ERROR',
    reason: 'http_error',
    httpStatus: 502,
    providerCode: 'server_error',
  });
  expect(JSON.stringify(modelFailure(error))).not.toContain(secret);
  expect(modelFailure(new TypeError(secret, { cause: { code: 'ECONNRESET' } }))).toEqual({
    code: 'AI_MODEL_CONNECTION_FAILED',
    reason: 'network_error',
    networkCode: 'ECONNRESET',
  });
  expect(modelFailure(new Error(secret))).toEqual({ reason: 'request_failed' });
});
