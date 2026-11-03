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
  if (!response.ok) {
    if (response.status === 401 && url !== '/auth/login') {
      state.me = null;
      state.catalog = null;
      state.csrf = null;
      window.dispatchEvent(new Event('cage:session-expired'));
    }
    const detail =
      data.domainCode || data.detail?.message || (typeof data.detail === 'string' ? data.detail : '');
    const message = `${errors[data.code] ?? '服务暂时无法处理请求'}${detail ? `：${detail}` : ''}`;
    throw new ApiError(data.code, message);
  }
  return data as T;
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
