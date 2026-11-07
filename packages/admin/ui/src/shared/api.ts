import { h, icon } from './dom.js';
import type { Catalog, Me } from './types.js';

export const state: { me: Me | null; catalog: Catalog | null; csrf: string | null } = {
  me: null,
  catalog: null,
  csrf: null,
};
const errors: Record<string, string> = {
  UNAUTHENTICATED: '登录已过期，请重新登录',
  FORBIDDEN: '你没有执行此操作的权限',
  NOT_FOUND: '记录不存在或不在你的数据范围内',
  INVALID_INPUT: '请检查填写内容',
  INVALID_TRANSITION: '当前状态不允许此操作',
  CONSTRAINT_VIOLATED: '未满足操作规则',
  INVARIANT_VIOLATED: '数据未满足业务规则',
  CONFLICT: '数据已更新，请刷新后重试',
  DOMAIN_ERROR: '业务规则未满足',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
};
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 系统管理同样使用会话、CSRF 和幂等键，不拥有绕过领域命令的写入通道。 */
export async function api<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method === 'POST') {
    if (!state.csrf) {
      const response = await fetch('/auth/csrf', { credentials: 'include' });
      if (!response.ok) throw new Error('无法获取安全令牌，请刷新后重试');
      state.csrf = (await response.json()).token;
    }
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = state.csrf!;
    headers['idempotency-key'] = crypto.randomUUID();
  }
  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await response.json();
  checkResponse(response, data, url);
  return data as T;
}

function checkResponse(response: Response, data: any, url: string): void {
  if (!response.ok) {
    if (response.status === 401 && url !== '/auth/login') {
      state.me = null;
      state.catalog = null;
      state.csrf = null;
      window.dispatchEvent(new Event('cage:session-expired'));
    }
    // 参数校验使用 issues 数组。丢弃它会让所有字段错误都退化成“请检查填写内容”。
    const fields: Record<string, string> = { baseUrl: 'API 基地址', model: '模型名称', apiKey: 'API Key', apiFormat: '接口协议', contextWindowTokens: '上下文窗口', responsesCompaction: '服务端自动压缩', timeoutMs: '调用超时', label: '显示名称', version: '配置版本', description: '性格描述', avatar: '头像', address: '称呼', examples: '说话示例', defaultKey: '默认性格' };
    const detail = data.domainCode || data.detail?.message || (Array.isArray(data.detail)
      ? data.detail.map((issue: { path?: string; message?: string }) => `${fields[issue.path ?? ''] ?? issue.path ?? '参数'}：${issue.message ?? '格式无效'}`).join('；')
      : typeof data.detail === 'string' ? data.detail : '');
    const message = `${errors[data.code] ?? '服务暂时无法处理请求'}${detail ? `：${detail}` : ''}`;
    throw new ApiError(data.code, message);
  }
}

/** 管理预览逐段更新，沿用登录、CSRF 和错误提示；不将模型文本作为 HTML 插入。 */
export async function postEvents<T>(url: string, body: unknown, onEvent: (event: T) => void, signal: AbortSignal): Promise<void> {
  if (!state.csrf) state.csrf = (await api<{ token: string }>('GET', '/auth/csrf')).token;
  const response = await fetch(url, { method: 'POST', credentials: 'include', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-csrf-token': state.csrf!, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
  if (!response.ok) checkResponse(response, await response.json(), url);
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('试聊连接未建立，请重试');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error('试聊返回内容过大');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const value = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (value) onEvent(JSON.parse(value) as T);
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const can = (capability: string) => Boolean(state.me?.capabilities.includes(capability));
export function toast(message: string, failed = false) {
  const item = h(
    'div',
    { class: `toast ${failed ? 'error' : 'success'}`, role: failed ? 'alert' : 'status' },
    icon(failed ? 'info' : 'check'),
    message,
  );
  document.getElementById('notifications')!.append(item);
  setTimeout(() => item.remove(), 5000);
}

/** 失败会明确显示原因；按钮等待返回，避免界面把未保存的授权显示成成功。 */
export async function run<T>(
  action: () => Promise<T>,
  success?: string,
  button?: HTMLButtonElement,
): Promise<T | null> {
  if (button) button.disabled = true;
  try {
    const result = await action();
    if (success) toast(success);
    return result;
  } catch (error) {
    toast(error instanceof TypeError ? '连接失败，请检查网络与 API 服务' : (error as Error).message, true);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}
