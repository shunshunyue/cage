// @yss123/cage-client：前端 SDK 运行时。生成的 contracts 包在它上面：请求、错误码、can()、查询 hooks。
// can() 只影响按钮显示；就算有人绕过前端直接调接口，内核第 3 关一样会拒绝。
import { useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { z } from 'zod';
import { FileUploadTask, type FileUploadOptions, type UploadTarget, type UploadSession, type UploadPart, type FileInfo } from './files.js';
export * from './files.js';

/** 所有接口都可能返回的通用错误码 */
export type CommonError = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'INTERNAL' | 'NETWORK' | 'CANCELLED' | 'TIMEOUT';

export type CageResult<T, E extends string = never> =
  | { ok: true; data: T; code?: undefined }
  | { ok: false; code: E | CommonError; domainCode?: string; detail?: unknown; status: number; requestId?: string; data?: undefined };

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** 会话失效时调用（例如跳转登录页） */
  onUnauthenticated?: () => void;
  timeoutMs?: number;
}

export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; idempotencyKey?: string }
export interface SessionUser { id: string; username: string; name: string; deptId: string }
export interface SessionSnapshot { user: SessionUser | null; capabilities: readonly string[]; revision: number }
export type SessionReason = 'loaded' | 'logout' | 'unauthenticated' | 'account-switch' | 'configured';

/** 导出和导入都先返回任务；HTTP 202 不表示业务处理已经完成。 */
export interface TransferTask {
  id: string;
  kind: 'export' | 'import';
  target: string;
  status: 'queued' | 'processing' | 'retrying' | 'completed' | 'failed' | 'expired';
  createdAt: string;
  expiresAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  result: { rows: number; succeeded?: number; failed?: number; filename?: string; atomic?: boolean } | null;
}

/** 导入结果不包含原始单元格值；业务前端可将字段名映射成自己的中文列名。 */
export interface ImportReport {
  rows: number;
  succeeded: number;
  failed: number;
  atomic: boolean;
  filename: string;
  results: { row: number; ok: boolean; code?: string; domainCode?: string; fields?: string[] }[];
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
  private session: SessionSnapshot = { user: null, capabilities: [], revision: 0 };
  private listeners = new Set<(snapshot: SessionSnapshot, reason: SessionReason) => void>();
  private pending = new Set<AbortController>();
  constructor(private opts: ClientOptions = {}) {}

  getSession = (): SessionSnapshot => this.session;
  subscribe = (listener: (snapshot: SessionSnapshot, reason: SessionReason) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  can(capability: string): boolean { return this.session.capabilities.includes(capability); }
  setSession(user: SessionUser | null, capabilities: readonly string[], reason: SessionReason = 'loaded'): void {
    this.session = { user, capabilities: [...capabilities], revision: this.session.revision + 1 };
    for (const listener of this.listeners) listener(this.session, reason);
  }
  clearSession(reason: SessionReason): void {
    for (const request of this.pending) request.abort();
    this.csrfToken = null;
    this.setSession(null, [], reason);
  }
  configure(opts: ClientOptions): void { this.clearSession('configured'); this.opts = opts; }

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

  async csrf(refresh = false, signal?: AbortSignal): Promise<string> {
    if (this.csrfToken && !refresh) return this.csrfToken;
    const r = await this.f(this.url('/auth/csrf'), { credentials: 'include', signal });
    if (!r.ok) throw new Error('CSRF token request failed');
    const token = ((await r.json()) as { token: string }).token;
    signal?.throwIfAborted();
    this.csrfToken = token;
    return this.csrfToken;
  }

  private async handle<T, E extends string>(res: Response, revision: number): Promise<CageResult<T, E>> {
    const expire = () => {
      if (res.status === 401 && revision === this.session.revision) {
        this.clearSession('unauthenticated');
        this.opts.onUnauthenticated?.();
      }
    };
    let text: string;
    try { text = await res.text(); }
    catch (error) {
      if (res.status !== 401) throw error;
      expire();
      return { ok: false, code: 'UNAUTHENTICATED', status: 401 };
    }
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (res.ok) return { ok: true, data: body as T };
    expire();
    const fallback: Record<number, CommonError> = { 400: 'INVALID_INPUT', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 429: 'RATE_LIMITED' };
    return { ok: false, code: typeof body?.code === 'string' ? body.code : fallback[res.status] ?? 'INTERNAL', domainCode: body?.domainCode, detail: body?.detail, status: res.status, requestId: body?.requestId };
  }

  /** 写请求：自动附带幂等键和 CSRF 令牌。返回值和错误码都有类型。 */
  private async request<T, E extends string>(options: RequestOptions, run: (signal: AbortSignal, revision: number) => Promise<CageResult<T, E>>): Promise<CageResult<T, E>> {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, code: 'INVALID_INPUT', status: 0, detail: 'timeoutMs must be positive and finite' };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    this.pending.add(controller);
    try {
      if (controller.signal.aborted) return { ok: false, code: 'CANCELLED', status: 0 };
      // Await includes response-body consumption, so read failures use the same result contract as fetch failures.
      return await run(controller.signal, this.session.revision);
    } catch {
      return { ok: false, code: timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'CANCELLED' : 'NETWORK', status: 0 };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      this.pending.delete(controller);
    }
  }

  async post<T, E extends string = never>(path: string, body: unknown = {}, o: RequestOptions = {}): Promise<CageResult<T, E>> {
    const key = o.idempotencyKey ?? uuid();
    return this.request<T, E>(o, async (signal, revision) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await this.f(this.url(path), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-csrf-token': await this.csrf(attempt > 0, signal) },
          signal,
          body: JSON.stringify(body ?? {}),
        });
        const r = await this.handle<T, E>(res, revision);
        // CSRF 令牌过期：刷新后用同一个幂等键重试一次
        if (!r.ok && r.status === 403 && r.detail === 'CSRF' && attempt === 0) continue;
        return r;
      }
      return { ok: false, code: 'NETWORK', status: 0 };
    });
  }

  async get<T>(path: string, query?: Record<string, unknown>, options: RequestOptions = {}): Promise<CageResult<T, 'NOT_FOUND'>> {
    return this.request<T, 'NOT_FOUND'>(options, async (signal, revision) => {
      const res = await this.f(this.url(path, query), { credentials: 'include', signal });
      return await this.handle<T, 'NOT_FOUND'>(res, revision);
    });
  }

  async login(username: string, password: string) {
    this.clearSession('account-switch');
    const revision = this.session.revision;
    const r = await this.post<{ ok: true }, never>('/auth/login', { username, password });
    if (r.ok) {
      if (revision !== this.session.revision) return { ok: false as const, code: 'CANCELLED' as const, status: 0 };
      this.csrfToken = null;
      const loaded = await loadMe(this);
      if (!loaded.ok) return loaded;
    }
    return r;
  }

  /** 创建可恢复的私有文件会话；绑定仍通过业务命令执行。 */
  beginUpload(input: UploadTarget & { filename: string; bytes: number; contentType: string }, options: RequestOptions = {}) {
    return this.post<UploadSession, 'CONFLICT' | 'NOT_FOUND' | 'INVALID_TRANSITION'>('/api/sys/uploads', input, options);
  }
  uploadSession(id: string, options: RequestOptions = {}) { return this.get<UploadSession>(`/api/sys/uploads/${encodeURIComponent(id)}`, undefined, options); }
  uploadSessions(target: UploadTarget, options: RequestOptions = {}) { return this.get<UploadSession[]>('/api/sys/uploads', { ...target }, options); }
  completeUpload(id: string, options: RequestOptions = {}) { return this.post<UploadSession, 'CONFLICT' | 'NOT_FOUND'>(`/api/sys/uploads/${encodeURIComponent(id)}/complete`, {}, options); }
  cancelUpload(id: string, options: RequestOptions = {}) { return this.post<{ ok: true }, 'CONFLICT' | 'NOT_FOUND'>(`/api/sys/uploads/${encodeURIComponent(id)}/cancel`, {}, options); }
  fileInfo(id: string, options: RequestOptions = {}) { return this.get<FileInfo>(`/api/sys/files/${encodeURIComponent(id)}`, undefined, options); }
  fileDownloadUrl(id: string) { return this.url(`/api/sys/files/${encodeURIComponent(id)}/download`); }
  upload(file: File, target: UploadTarget, options: FileUploadOptions = {}) { return new FileUploadTask(this, file, target, options); }
  uploadPart(id: string, number: number, body: Blob, sha256: string, options: RequestOptions = {}): Promise<CageResult<UploadPart, 'CONFLICT' | 'NOT_FOUND'>> {
    return this.request(options, async (signal, revision) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.f(this.url(`/api/sys/uploads/${encodeURIComponent(id)}/parts/${number}`), {
          method: 'POST', credentials: 'include', signal, body,
          headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': sha256, 'x-csrf-token': await this.csrf(attempt > 0, signal) },
        });
        const result = await this.handle<UploadPart, 'CONFLICT' | 'NOT_FOUND'>(response, revision);
        if (!result.ok && result.status === 403 && result.detail === 'CSRF' && attempt === 0) continue;
        return result;
      }
      return { ok: false, code: 'NETWORK', status: 0 };
    });
  }

  /** 上传的是命令输入 CSV；读侧导出包含系统列/掩码值，不应原样重新导入。 */
  async importCsv(command: string, csv: string, options: RequestOptions & { atomic?: boolean } = {}) {
    return this.post<TransferTask, 'CONFLICT' | 'NOT_FOUND'>('/api/sys/transfers/import', { command, csv, atomic: options.atomic ?? false }, options);
  }

  transfer(id: string, options: RequestOptions = {}) { return this.get<TransferTask>(`/api/sys/transfers/${encodeURIComponent(id)}`, undefined, options); }
  transfers(aggregate?: string) { return this.get<TransferTask[]>('/api/sys/transfers', { aggregate }); }

  importReport(id: string) { return this.get<ImportReport>(`/api/sys/transfers/${encodeURIComponent(id)}/download`); }

  /** 下载使用 cookie 会话，不把凭据放入 URL；服务端会再次检查当前授权。 */
  transferDownloadUrl(id: string) { return this.url(`/api/sys/transfers/${encodeURIComponent(id)}/download`); }

  async logout() {
    const r = await this.post('/auth/logout');
    if (r.ok) this.clearSession('logout');
    return r;
  }
}

/** 默认实例 */
export const client = new CageClient();

/** React 订阅上传状态；task 由调用方持有并在卸载时 dispose，暂停会保留服务端分片。 */
export function useFileUpload(task: FileUploadTask) { return useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot); }

export function configureClient(opts: ClientOptions): CageClient {
  client.configure(opts);
  return client;
}

// ---------------- 能力判断 ----------------

export function setCapabilities(list: string[], c: CageClient = client): void {
  c.setSession(c.getSession().user, list);
}

/** 登录后调用一次（client.login 已自动调用） */
export async function loadMe(c: CageClient = client) {
  const revision = c.getSession().revision;
  const r = await c.get<{ user: SessionUser | null; capabilities: string[] }>('/api/me');
  if (r.ok && revision === c.getSession().revision) c.setSession(r.data.user, r.data.capabilities);
  return r;
}

export const currentUser = (c: CageClient = client) => c.getSession().user;

/** 当前用户有没有某个能力点（只用于界面显示） */
export function can(capability: string, c: CageClient = client): boolean {
  return c.can(capability);
}

/** React：能力变化时自动重新渲染 */
export function useCan(capability: string, c: CageClient = client): boolean {
  return useSyncExternalStore(
    c.subscribe,
    () => c.can(capability),
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

export class CageCommandError<E extends string = string> extends Error {
  constructor(readonly result: Extract<CageResult<unknown, E>, { ok: false }>) {
    super(result.code);
    this.name = 'CageCommandError';
  }
}

/** Shared by the hook and non-React integrations: mutation success always means business success. */
export async function commandData<T, E extends string>(promise: Promise<CageResult<T, E>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new CageCommandError(result);
  return result.data;
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
    queryFn: async ({ signal }) => {
      const r = await client.get<T>(path, query, { signal });
      if (!r.ok) throw new CageQueryError(r);
      return schema ? schema.parse(r.data) : r.data;
    },
    ...rest,
  });
}

/** 列表：分页、排序、过滤参数统一 */
export function useCageList<T>(key: QueryKey, path: string, params: Record<string, unknown> = {}, itemSchema?: z.ZodType<T>, options: { enabled?: boolean } = {}) {
  return useQuery<Page<T>>({
    // 关系面板尚未选择主对象时不发请求，缓存键仍由调用者明确给出。
    enabled: options.enabled,
    queryKey: [...key, params],
    queryFn: async ({ signal }) => {
      const r = await client.get<Page<T>>(path, params, { signal });
      if (!r.ok) throw new CageQueryError(r);
      return itemSchema ? { ...r.data, items: r.data.items.map((i) => itemSchema.parse(i)) } : r.data;
    },
  });
}

/** 命令：成功后让相关查询失效 */
export function useCageCommand<A extends unknown[], T, E extends string>(fn: (...args: A) => Promise<CageResult<T, E>>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: A) => commandData(fn(...args)),
    onSuccess: () => {
      for (const k of invalidate) void qc.invalidateQueries({ queryKey: k });
    },
  });
}

/**
 * 可选的通用任务 hook，不包含页面和业务对象约定。
 * 业务前端拿到任务 id 后决定在哪里展示；仅处理中自动刷新，完成/失败/过期即停止。
 * 不使用 React 的项目直接调用 client.transfer(id) 即可。
 */
export function useTransfer(id: string | null) {
  return useQuery<TransferTask>({
    queryKey: ['cage-transfer', id],
    enabled: !!id,
    queryFn: async ({ signal }) => {
      const result = await client.transfer(id!, { signal });
      if (!result.ok) throw new CageQueryError(result);
      return result.data;
    },
    refetchInterval: (query) => ['queued', 'processing', 'retrying'].includes(query.state.data?.status ?? '') ? 2000 : false,
  });
}
