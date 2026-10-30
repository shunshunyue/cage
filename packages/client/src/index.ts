// @yss123/cage-client：前端 SDK 运行时。生成的 contracts 包在它上面：请求、错误码、can()、查询 hooks。
// can() 只影响按钮显示；就算有人绕过前端直接调接口，内核第 3 关一样会拒绝。
import { useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { z } from 'zod';

/** 所有接口都可能返回的通用错误码 */
export type CommonError = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'INTERNAL' | 'NETWORK';

export type CageResult<T, E extends string = never> =
  | { ok: true; data: T; code?: undefined }
  | { ok: false; code: E | CommonError; domainCode?: string; detail?: unknown; status: number; requestId?: string; data?: undefined };

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** 会话失效时调用（例如跳转登录页） */
  onUnauthenticated?: () => void;
}

function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export class CageClient {
  private csrfToken: string | null = null;
  constructor(private readonly opts: ClientOptions = {}) {}

  private get f(): typeof fetch {
    return this.opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private url(path: string, query?: Record<string, unknown>): string {
    const base = this.opts.baseUrl ?? '';
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return `${base}${path}${qs ? `?${qs}` : ''}`;
  }

  async csrf(refresh = false): Promise<string> {
    if (this.csrfToken && !refresh) return this.csrfToken;
    const r = await this.f(this.url('/auth/csrf'), { credentials: 'include' });
    this.csrfToken = ((await r.json()) as { token: string }).token;
    return this.csrfToken;
  }

  private async handle<T, E extends string>(res: Response): Promise<CageResult<T, E>> {
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (res.ok) return { ok: true, data: body as T };
    if (res.status === 401) this.opts.onUnauthenticated?.();
    return { ok: false, code: body?.code ?? 'INTERNAL', domainCode: body?.domainCode, detail: body?.detail, status: res.status, requestId: body?.requestId };
  }

  /** 写请求：自动附带幂等键和 CSRF 令牌。返回值和错误码都有类型。 */
  async post<T, E extends string = never>(path: string, body: unknown = {}, o: { idempotencyKey?: string } = {}): Promise<CageResult<T, E>> {
    const key = o.idempotencyKey ?? uuid();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.f(this.url(path), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-csrf-token': await this.csrf(attempt > 0) },
          body: JSON.stringify(body ?? {}),
        });
        const r = await this.handle<T, E>(res);
        // CSRF 令牌过期：刷新后用同一个幂等键重试一次
        if (!r.ok && r.status === 403 && r.detail === 'CSRF' && attempt === 0) continue;
        return r;
      } catch {
        if (attempt === 1) return { ok: false, code: 'NETWORK', status: 0 };
      }
    }
    return { ok: false, code: 'NETWORK', status: 0 };
  }

  async get<T>(path: string, query?: Record<string, unknown>): Promise<CageResult<T, 'NOT_FOUND'>> {
    try {
      const res = await this.f(this.url(path, query), { credentials: 'include' });
      return this.handle<T, 'NOT_FOUND'>(res);
    } catch {
      return { ok: false, code: 'NETWORK', status: 0 };
    }
  }

  async login(username: string, password: string) {
    const r = await this.post<{ ok: true }, never>('/auth/login', { username, password });
    if (r.ok) {
      this.csrfToken = null;
      await loadMe(this);
    }
    return r;
  }

  async logout() {
    const r = await this.post('/auth/logout');
    setCapabilities([]);
    this.csrfToken = null;
    return r;
  }
}

/** 默认实例 */
export const client = new CageClient();

export function configureClient(opts: ClientOptions): CageClient {
  Object.assign(client, new CageClient(opts));
  return client;
}

// ---------------- 能力判断 ----------------

let caps = new Set<string>();
let me: { user: { id: string; username: string; name: string; deptId: string } | null; capabilities: string[] } | null = null;
const listeners = new Set<() => void>();

export function setCapabilities(list: string[]): void {
  caps = new Set(list);
  for (const l of listeners) l();
}

/** 登录后调用一次（client.login 已自动调用） */
export async function loadMe(c: CageClient = client) {
  const r = await c.get<{ user: any; capabilities: string[] }>('/api/me');
  me = r.ok ? r.data : null;
  setCapabilities(r.ok ? r.data.capabilities : []);
  return r;
}

export const currentUser = () => me?.user ?? null;

/** 当前用户有没有某个能力点（只用于界面显示） */
export function can(capability: string): boolean {
  return caps.has(capability);
}

/** React：能力变化时自动重新渲染 */
export function useCan(capability: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => caps.has(capability),
    () => false,
  );
}

// ---------------- 查询 hooks（TanStack Query） ----------------

export class CageQueryError extends Error {
  constructor(readonly result: Extract<CageResult<unknown, string>, { ok: false }>) {
    super(result.code);
    this.name = 'CageQueryError';
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 详情或任意 GET：响应用 schema 校验 */
export function useCageQuery<T>(key: QueryKey, path: string, schema?: z.ZodType<T>, options: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'> & { query?: Record<string, unknown> } = {}) {
  const { query, ...rest } = options;
  return useQuery<T>({
    queryKey: query ? [...key, query] : key,
    queryFn: async () => {
      const r = await client.get<T>(path, query);
      if (!r.ok) throw new CageQueryError(r);
      return schema ? schema.parse(r.data) : r.data;
    },
    ...rest,
  });
}

/** 列表：分页、排序、过滤参数统一 */
export function useCageList<T>(key: QueryKey, path: string, params: Record<string, unknown> = {}, itemSchema?: z.ZodType<T>) {
  return useQuery<Page<T>>({
    queryKey: [...key, params],
    queryFn: async () => {
      const r = await client.get<Page<T>>(path, params);
      if (!r.ok) throw new CageQueryError(r);
      return itemSchema ? { ...r.data, items: r.data.items.map((i) => itemSchema.parse(i)) } : r.data;
    },
  });
}

/** 命令：成功后让相关查询失效 */
export function useCageCommand<A extends unknown[], T, E extends string>(fn: (...args: A) => Promise<CageResult<T, E>>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: A) => fn(...args),
    onSuccess: (r) => {
      if (r.ok) for (const k of invalidate) void qc.invalidateQueries({ queryKey: k });
    },
  });
}
