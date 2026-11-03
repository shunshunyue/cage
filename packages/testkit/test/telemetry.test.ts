// 合成标记覆盖没有 HTTP 日志装配时的默认内核日志，防止错误文本或任意快照泄漏。
import { consoleLogger } from '@yss123/cage-kernel';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
it('独立内核日志只保留执行元数据和错误机器码', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  const marker = 'SYNTHETIC_PRIVATE_VALUE';
  const error = Object.assign(new TypeError(marker), { code: '23505', detail: marker });
  const payload: Record<string, unknown> = { nested: [{ password: marker }] };
  payload.circular = payload;
  consoleLogger.error({ requestId: 'request-1', outboxId: 2, payload, err: error, url: `/api?token=${marker}` }, '命令执行异常');
  expect(output).toHaveBeenCalledOnce();
  expect(JSON.stringify(output.mock.calls)).not.toContain(marker);
  expect(JSON.parse(String(output.mock.calls[0][1]))).toEqual({ requestId: 'request-1', outboxId: 2, err: { type: 'TypeError', code: '23505' } });
});
