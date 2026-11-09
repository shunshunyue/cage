/**
 * 管理 UI 网络适配的回归，使用 mock fetch 与可控 ReadableStream，不连接真实 API 或模型。
 * 保护字段级校验原因及 SSE 跨数据块增量交付；每例恢复 fetch mock，流测试在 finally 中结束流并清理 CSRF 状态。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { api, postEvents, state } from '../ui/src/shared/api.js';

afterEach(() => vi.restoreAllMocks());
/**
 * 构造两个不同字段的校验原因，确保用户可定位错误字段，而非只收到笼统 INVALID_INPUT。
 */
it('Admin 保留服务端字段校验原因，用户能定位模型配置错误', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'INVALID_INPUT', detail: [
    { path: 'baseUrl', message: '使用 HTTP 或 HTTPS API 地址' },
    { path: 'timeoutMs', message: '超时必须在允许范围内' },
  ] }), { status: 400, headers: { 'content-type': 'application/json' } }));
  await expect(api('GET', '/api/ai/admin/models')).rejects.toMatchObject({
    code: 'INVALID_INPUT', message: '请检查填写内容：API 基地址：使用 HTTP 或 HTTPS API 地址；调用超时：超时必须在允许范围内',
  });
});

/**
 * 故意将 CRLF 帧分隔符拆成两个网络块；在关闭流之前断言首段已交付，排除收完整响应后再显示的实现。
 */
it('Admin 试聊跨块解析 SSE，收到第一段时便交付而不等待完整回复', async () => {
  state.csrf = 'preview-csrf';
  let stream!: ReadableStreamDefaultController<Uint8Array>, received!: () => void, finished = false;
  const first = new Promise<void>(resolve => { received = resolve; });
  const encode = (value: string) => new TextEncoder().encode(value);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    expect(options?.headers).toMatchObject({ 'x-csrf-token': 'preview-csrf', accept: 'text/event-stream' });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller; controller.enqueue(encode('data: {"type":"delta","text":"先看这段"}\r'));
      controller.enqueue(encode('\n\r\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const delivered: any[] = [];
  const pending = postEvents('/api/ai/admin/personality-preview', {}, event => { delivered.push(event); received(); }, new AbortController().signal)
    .then(() => { finished = true; });
  try {
    await first; expect(finished).toBe(false); expect(delivered).toEqual([{ type: 'delta', text: '先看这段' }]);
    stream.enqueue(encode('data: {"type":"done","result":{"text":"完成"}}\n\n'));
  } finally { stream.close(); await pending; state.csrf = null; }
  expect(delivered.at(-1)).toEqual({ type: 'done', result: { text: '完成' } });
});
