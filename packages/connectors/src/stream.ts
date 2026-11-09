/**
 * 模型等 SSE 请求的传输适配：复用连接器主机、密钥、限流和超时边界，只传递 data 帧文本。
 * JSON 业务解析与模型语义由上层负责，本层不记录提示词、响应正文或多租户凭据。
 */
import { ConnectorError, secrets, stage, take } from './runtime.js';
import type { Connector } from './primitives.js';

/** 模型等流式协议共用连接器的地址、密钥、限流和取消边界。响应正文不写通用日志。 */
/**
 * 只向所选白名单主机 POST，禁止重定向和 fake 外呼；凭据可按本次调用独立读取。
 * 逐块 UTF-8 解码并按 SSE 空行合并多个 data 行，await onData 提供消费背压；总响应上限 4 MiB。
 * 取消、超限或回调失败都向上传播，finally 取消 reader 并释放锁；HTTP 错误只保留状态和稳定供应商码。
 */
export async function streamJson(connector: Connector, path: string, body: unknown, signal: AbortSignal,
  onData: (data: string) => Promise<void>, options: { environment?: string; protocol?: 'http:' | 'https:'; credential?: () => Promise<string> } = {}): Promise<void> {
  const environment = options.environment ?? stage(), protocol = options.protocol ?? 'https:';
  if (!path.startsWith('/') || path.startsWith('//')) throw new ConnectorError('流式操作需要同主机绝对路径', null, false);
  const host = connector.hosts[environment];
  if (environment === 'fake') throw new ConnectorError('fake 环境必须显式配置模型 fake，禁止外呼', null, false);
  if (!host) throw new ConnectorError('当前阶段未配置连接器地址', null, false);
  const abort = AbortSignal.any([signal, AbortSignal.timeout(connector.timeoutMs)]);
  await take(connector, abort);
  // 每次调用独立提供凭据，动态模型不得改动全局 SecretProvider 而串用其他租户密钥。
  const token = options.credential ? await options.credential() : connector.secret ? await secrets.get(connector.secret) : undefined;
  const url = new URL(path, `${protocol}//${host}`);
  if (url.host !== host || url.protocol !== protocol || !['http:', 'https:'].includes(protocol)) throw new ConnectorError('流式地址超出连接器白名单', null, false);
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: abort,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) });
  if (!response.ok || !response.body) {
    // 只提取供应商的稳定错误码/特定兼容性标记，不把响应正文写入日志或 Cage 运行记录。
    let providerCode: string | undefined;
    try {
      const payload = await response.clone().json() as any, message = String(payload?.message ?? payload?.error?.message ?? '');
      const code = payload?.code ?? payload?.error?.code;
      if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code)) providerCode = code;
      if (/previous_response_id\s+requires/i.test(message)) providerCode = 'PREVIOUS_RESPONSE_ID_UNSUPPORTED';
    } catch { /* 非 JSON 错误只保留 HTTP 状态 */ }
    await response.body?.cancel();
    throw new ConnectorError(`模型连接器返回 ${response.status}`, response.status, response.status === 429 || response.status >= 500, 'rejected', providerCode);
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0, data: string[] = [];
  const line = async (value: string) => {
    if (!value) { if (data.length) await onData(data.join('\n')); data = []; }
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    for (;;) {
      abort.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new ConnectorError('模型响应超过 4 MiB', response.status, false);
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { const value = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1); await line(value); }
    }
    buffer += decoder.decode();
    if (buffer) await line(buffer.replace(/\r$/, ''));
    await line('');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
