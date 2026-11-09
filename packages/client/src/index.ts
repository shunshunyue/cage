/**
 * Cage 浏览器 SDK 公共入口：封装 Cookie 会话、CSRF、类型化结果、取消与超时，并提供生成契约所用的 React 查询/命令 hooks。
 * AI 与文件客户端复用本实例的登录状态和网络边界；前端仅消费协议和契约，不导入 domain、数据库或内核。can 只控制界面，真正授权、范围和并发仍由服务端执行。
 */
// @yss123/cage-client：前端 SDK 运行时。生成的 contracts 包在它上面：请求、错误码、can()、查询 hooks。
// can() 只影响按钮显示；就算有人绕过前端直接调接口，内核第 3 关一样会拒绝。
import { useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { z } from 'zod';
import { AiClient, type ApprovalHistory } from './ai.js';
export * from './ai.js';
import { FileUploadTask, type FileUploadOptions, type UploadTarget, type UploadSession, type UploadPart, type FileInfo } from './files.js';
export * from './files.js';
import type { ApprovalTask, ApprovalTaskAction, ApprovalTaskActionResult, ApprovalTaskHistory, ApprovalNotices, ApprovalRequest } from './approval.js';
export * from './approval.js';

/** 所有接口都可能返回的通用错误码 */
/**
 * 所有网络接口可能出现的公共错误码。
 * NETWORK、CANCELLED、TIMEOUT 可在浏览器本地生成，不能与服务端业务拒绝混为一谈；特定命令另通过泛型补充领域错误。
 */
export type CommonError = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'INTERNAL' | 'NETWORK' | 'CANCELLED' | 'TIMEOUT';

/**
 * 统一成功/失败判别联合，必须先检查 ok 才能读取 data。
 * 失败保留稳定 code、可选领域码、detail 和 requestId；status 为 HTTP 状态，本地网络/取消/超时使用 0。成功的 HTTP 202 仍可能仅表示任务接受，需看具体 DTO 状态。
 */
export type CageResult<T, E extends string = never> =
  | { ok: true; data: T; code?: undefined }
  | { ok: false; code: E | CommonError; domainCode?: string; detail?: unknown; status: number; requestId?: string; data?: undefined };

/**
 * 客户端实例配置；baseUrl 用于接口前缀，自定义 fetch 便于宿主接入或测试。
 * 超时覆盖整个响应体读取，不只是建立连接；认证失效回调由当前会话版本匹配的 401 触发。
 */
export interface ClientOptions {
  /**
   * 接口基地址前缀；省略时使用当前站点相对路径。
   */
  baseUrl?: string;
  /**
   * 可选网络实现，默认使用浏览器全局 fetch。
   */
  fetch?: typeof fetch;
  /** 会话失效时调用（例如跳转登录页） */
  onUnauthenticated?: () => void;
  /**
   * 实例默认请求超时，单位毫秒；单次 RequestOptions 可覆盖。
   */
  timeoutMs?: number;
}

/**
 * 单次请求取消、超时和写入幂等选项。
 * idempotencyKey 在调用方跨请求重试时应复用；没有显式键的独立 post 调用会各自生成新键，不等于自动业务重试。
 */
export interface RequestOptions { /** 调用方取消信号，与会话切换及超时共同中止请求。 */ signal?: AbortSignal; /** 单次请求完整生命周期的超时毫秒数，必须正且有限。 */ timeoutMs?: number; /** 写请求幂等键；跨请求恢复同一业务意图时由调用方复用。 */ idempotencyKey?: string }
/**
 * 当前登录用户的公开身份摘要，不含凭据、角色规则或完整组织对象。
 */
export interface SessionUser { /** 登录用户 UUID。 */ id: string; /** 登录账户名，不是认证凭据。 */ username: string; /** 用户展示名称。 */ name: string; /** 用户所属部门 ID，不能据此单独推断数据范围。 */ deptId: string }
/**
 * 供 hooks 订阅的本地登录与能力快照。
 * revision 每次设置递增，用于防止旧请求覆盖新账户状态；capabilities 仅作界面判断，不是服务器授权凭证。
 */
export interface SessionSnapshot { /** 当前登录用户摘要；空身份为 null。 */ user: SessionUser | null; /** 当前本地能力名称副本，只供界面判断。 */ capabilities: readonly string[]; /** 本地会话更新版本，防止旧异步响应污染新身份。 */ revision: number }
/**
 * 会话状态通知原因：loaded 为身份刷新，其余表示退出、失效、账户切换或重配置。
 * AI 订阅和上传任务据此中止旧会话操作，普通 loaded 刷新不主动中断。
 */
export type SessionReason = 'loaded' | 'logout' | 'unauthenticated' | 'account-switch' | 'configured';

/** 导出和导入都先返回任务；HTTP 202 不表示业务处理已经完成。 */
/**
 * 导入/导出的异步任务协议，接受请求后应继续读取 status。
 * completed 才有完成结果，failed/expired 为终态；result 行数和成功失败数属于报告摘要，不能由 HTTP 202 推断业务已完成。
 */
export interface TransferTask {
  /**
   * 异步传输任务 UUID。
   */
  id: string;
  /**
   * 导出或导入任务类型。
   */
  kind: 'export' | 'import';
  /**
   * 服务端目标聚合或命令标识。
   */
  target: string;
  /**
   * 排队、处理、重试、完成、失败或过期状态。
   */
  status: 'queued' | 'processing' | 'retrying' | 'completed' | 'failed' | 'expired';
  /**
   * 任务创建 UTC 时间。
   */
  createdAt: string;
  /**
   * 任务或下载结果到期时间。
   */
  expiresAt: string;
  /**
   * 处理结束时间，尚未结束时为 null。
   */
  finishedAt: string | null;
  /**
   * 失败稳定错误码，没有错误时为 null。
   */
  errorCode: string | null;
  /**
   * 完成摘要，未产出时为 null；rows 为处理行数，其余字段按任务类型提供。
   */
  result: { rows: number; succeeded?: number; failed?: number; filename?: string; atomic?: boolean } | null;
}

/** 导入结果不包含原始单元格值；业务前端可将字段名映射成自己的中文列名。 */
/**
 * 导入处理报告，包含总数、原子策略和逐行稳定错误信息。
 * 不返回原始 CSV 单元格值；row 为服务端报告行号，fields 可由应用映射成中文列名，失败原因以 code/domainCode 为准。
 */
export interface ImportReport {
  /**
   * 报告总行数。
   */
  rows: number;
  /**
   * 成功处理行数，原子失败时以服务端报告为准。
   */
  succeeded: number;
  /**
   * 失败行数。
   */
  failed: number;
  /**
   * 本次导入是否使用原子提交策略。
   */
  atomic: boolean;
  /**
   * 报告下载文件名。
   */
  filename: string;
  /**
   * 逐行结果：row 为报告行号，ok 表示成功，失败可含错误码及字段名而不含原始值。
   */
  results: { row: number; ok: boolean; code?: string; domainCode?: string; fields?: string[] }[];
}

/**
 * 生成写请求幂等键，优先浏览器 crypto.randomUUID。
 * 兼容回退使用 Math.random 只用于请求标识，不应复用为密码、会话秘密或其他安全凭据。
 */
function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * 独立的浏览器网络与会话容器，自动携带 Cookie、维护 CSRF 并统一返回 CageResult。
 * 账户切换/退出/重配置取消在途请求，响应通过会话 revision 避免旧 401 清空新身份；业务命令仅对明确 CSRF 过期重试一次，不自动重放未知网络结果。
 */
export class CageClient {
  /**
   * 共享此实例会话和请求策略的 AI 子客户端。
   */
  readonly ai = new AiClient(this);
  /**
   * 当前会话缓存的 CSRF 令牌；退出或配置切换时清空。
   */
  private csrfToken: string | null = null;
  /**
   * 当前本地身份快照，用 revision 隔离异步响应。
   */
  private session: SessionSnapshot = { user: null, capabilities: [], revision: 0 };
  /**
   * 会话变更订阅者，供能力 hooks、AI 和上传任务清理状态。
   */
  private listeners = new Set<(snapshot: SessionSnapshot, reason: SessionReason) => void>();
  /**
   * 当前在途请求控制器集合，会话清空时统一中止。
   */
  private pending = new Set<AbortController>();
  /**
   * 保存实例配置并初始化 AI 子客户端；不发起登录、加载权限或取得 CSRF。
   */
  constructor(private opts: ClientOptions = {}) {}

  /**
   * 读取稳定会话快照供 UI 订阅，不进行网络 IO。
   */
  getSession = (): SessionSnapshot => this.session;
  /**
   * 注册会话变更监听并返回清理函数；监听接收新快照及变更原因。
   */
  subscribe = (listener: (snapshot: SessionSnapshot, reason: SessionReason) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /**
   * 读取本地能力列表用于界面显示；调用方不能用此结果代替服务端授权或数据范围校验。
   */
  can(capability: string): boolean { return this.session.capabilities.includes(capability); }
  /**
   * 替换用户与能力副本，递增 revision 并同步通知订阅者。
   * 这是本地状态操作，不创建服务器会话，也不授予真实能力。
   */
  setSession(user: SessionUser | null, capabilities: readonly string[], reason: SessionReason = 'loaded'): void {
    this.session = { user, capabilities: [...capabilities], revision: this.session.revision + 1 };
    for (const listener of this.listeners) listener(this.session, reason);
  }
  /**
   * 取消全部在途请求、清除 CSRF 并广播空身份。
   * 理由传给 AI/上传等订阅者清理旧账户状态；服务器注销由 logout 的 HTTP 成功负责。
   */
  clearSession(reason: SessionReason): void {
    for (const request of this.pending) request.abort();
    this.csrfToken = null;
    this.setSession(null, [], reason);
  }
  /**
   * 先以 configured 清空旧会话和在途请求，再替换网络配置，防止旧服务地址状态混入新客户端。
   */
  configure(opts: ClientOptions): void { this.clearSession('configured'); this.opts = opts; }

  /**
   * 解析当前配置的 fetch 实现；默认在调用时使用全局 fetch，便于宿主替换或测试注入。
   */
  private get f(): typeof fetch {
    return this.opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /**
   * 把路径加上 baseUrl 并编码查询项；省略 undefined/null/空字符串，其余值按 String 转换。
   * 复杂查询结构应由生成契约约定编码，不在这里递归展开对象。
   */
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

  /**
   * 读取缓存令牌或通过带 Cookie 的 /auth/csrf 刷新，并在写缓存前检查取消信号。
   * 失败向请求包装层抛出；不把 CSRF 作为用户身份或业务权限凭证。
   */
  async csrf(refresh = false, signal?: AbortSignal): Promise<string> {
    if (this.csrfToken && !refresh) return this.csrfToken;
    const r = await this.f(this.url('/auth/csrf'), { credentials: 'include', signal });
    if (!r.ok) throw new Error('CSRF token request failed');
    const token = ((await r.json()) as { token: string }).token;
    signal?.throwIfAborted();
    this.csrfToken = token;
    return this.csrfToken;
  }

  /**
   * 完整读取响应体，尽量解析 JSON，并转换为成功数据或稳定失败结果。
   * 401 仅在请求开始 revision 仍匹配当前会话时清空身份和通知登录回跳；旧账户响应不会注销新账户。
   * 非 JSON 错误按 HTTP 状态提供通用码，保留服务端已返回的领域码、详情和 requestId。
   */
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

  /** 普通请求和流请求共用的生命周期包装；具体 HTTP 方法负责附带 CSRF、幂等键或协议头。 */
  /**
   * 包裹一次完整网络操作，统一处理外部取消、会话取消和默认 30 秒超时。
   * 等待包含响应体消费，任何读取失败也转换为 CageResult；本地失败 status 为 0，finally 清理计时器、监听器和 pending 引用。
   */
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
      // 等待范围包含响应体消费，使正文读取失败也使用与 fetch 失败一致的类型化结果。
      return await run(controller.signal, this.session.revision);
    } catch {
      return { ok: false, code: timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'CANCELLED' : 'NETWORK', status: 0 };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      this.pending.delete(controller);
    }
  }

  /**
   * 发送带 JSON、Cookie、CSRF 和稳定幂等键的 POST。
   * 仅在服务端明确返回 403/CSRF 时刷新令牌并复用同一键重试一次；未知网络结果不自动重放，调用方需要跨调用重试时显式复用键。
   */
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

  /**
   * 发送带 Cookie 的 GET，并复用超时、会话取消和结果解析；查询参数通过统一 URL 编码。
   */
  async get<T>(path: string, query?: Record<string, unknown>, options: RequestOptions = {}): Promise<CageResult<T, 'NOT_FOUND'>> {
    return this.request<T, 'NOT_FOUND'>(options, async (signal, revision) => {
      const res = await this.f(this.url(path, query), { credentials: 'include', signal });
      return await this.handle<T, 'NOT_FOUND'>(res, revision);
    });
  }

  /** 流消费与普通请求共用会话取消、401 和超时处理；正文不走 JSON 响应解析。 */
  /**
   * 发送接受 SSE 的 GET，默认超时 60 秒，并等待 consume 完整消费正文。
   * 复用普通请求的会话取消和 401 逻辑；成功响应必须有流正文及 text/event-stream 类型，流解析由消费方承担。
   */
  async stream(path: string, query: Record<string, unknown>, consume: (body: ReadableStream<Uint8Array>) => Promise<void>, options: RequestOptions = {}): Promise<CageResult<void>> {
    return this.request({ timeoutMs: 60_000, ...options }, async (signal, revision) => {
      const res = await this.f(this.url(path, query), { credentials: 'include', signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok) return this.handle<void, never>(res, revision);
      if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return { ok: false, code: 'NETWORK', status: res.status };
      await consume(res.body);
      return { ok: true, data: undefined };
    });
  }

  /**
   * 发送带 Cookie 与 CSRF 的 DELETE，复用统一结果处理；此方法不执行 POST 的 CSRF 刷新重试循环。
   */
  async delete<T>(path: string, options: RequestOptions = {}): Promise<CageResult<T>> {
    return this.request(options, async (signal, revision) => {
      const res = await this.f(this.url(path), { method: 'DELETE', credentials: 'include', signal, headers: { 'x-csrf-token': await this.csrf(false, signal) } });
      return this.handle<T, never>(res, revision);
    });
  }

  /**
   * 先取消旧账户请求并清空本地身份，再提交凭据并加载 /api/me。
   * 只有会话 revision 未被其他操作改变时接受登录结果，成功后丢弃旧 CSRF；身份装载失败按其错误返回，不伪报已可使用业务。
   */
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
  /**
   * 为指定命令/字段创建私有文件上传会话，返回分片计划。
   * 这是字节暂存入口，最终业务字段绑定必须由领域命令执行。
   */
  beginUpload(input: UploadTarget & { filename: string; bytes: number; contentType: string }, options: RequestOptions = {}) {
    return this.post<UploadSession, 'CONFLICT' | 'NOT_FOUND' | 'INVALID_TRANSITION'>('/api/sys/uploads', input, options);
  }
  /**
   * 读取指定上传会话及已确认分片，供恢复时重新验证文件内容。
   */
  uploadSession(id: string, options: RequestOptions = {}) { return this.get<UploadSession>(`/api/sys/uploads/${encodeURIComponent(id)}`, undefined, options); }
  /**
   * 按业务目标列出当前可恢复上传会话，服务端验证归属和命令权限。
   */
  uploadSessions(target: UploadTarget, options: RequestOptions = {}) { return this.get<UploadSession[]>('/api/sys/uploads', { ...target }, options); }
  /**
   * 请求合并并验证已上传分片，返回会话状态；同会话完成操作可恢复重试，ready 仍未业务绑定。
   */
  completeUpload(id: string, options: RequestOptions = {}) { return this.post<UploadSession, 'CONFLICT' | 'NOT_FOUND'>(`/api/sys/uploads/${encodeURIComponent(id)}/complete`, {}, options); }
  /**
   * 请求服务器取消上传会话并进入清理流程；失败通过 CageResult 返回，不能先假定文件已删除。
   */
  cancelUpload(id: string, options: RequestOptions = {}) { return this.post<{ ok: true }, 'CONFLICT' | 'NOT_FOUND'>(`/api/sys/uploads/${encodeURIComponent(id)}/cancel`, {}, options); }
  /**
   * 读取当前有权访问的私有文件元数据，不返回存储凭据。
   */
  fileInfo(id: string, options: RequestOptions = {}) { return this.get<FileInfo>(`/api/sys/files/${encodeURIComponent(id)}`, undefined, options); }
  /**
   * 构建使用 Cookie 会话的私有下载地址；服务端每次下载重新检查当前授权，URL 本身不授予访问权。
   */
  fileDownloadUrl(id: string) { return this.url(`/api/sys/files/${encodeURIComponent(id)}/download`); }
  /**
   * 创建可订阅的 FileUploadTask，构造阶段不自动上传；调用 start，并在废弃时 dispose。
   */
  upload(file: File, target: UploadTarget, options: FileUploadOptions = {}) { return new FileUploadTask(this, file, target, options); }
  /**
   * 上传一个一基编号分片，携带 SHA-256 摘要、Cookie 与 CSRF。
   * 只对明确 CSRF 错误刷新一次，内容一致性及分片幂等由服务端校验；网络重试由 FileUploadTask 的有界策略负责。
   */
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
  /**
   * 把命令输入 CSV 提交为异步导入任务，atomic 默认 false。
   * 读侧导出可能包含系统列或掩码值，不能保证可原样重新导入；真正行级业务写由 worker 走目标命令。
   */
  async importCsv(command: string, csv: string, options: RequestOptions & { atomic?: boolean } = {}) {
    return this.post<TransferTask, 'CONFLICT' | 'NOT_FOUND'>('/api/sys/transfers/import', { command, csv, atomic: options.atomic ?? false }, options);
  }

  /**
   * 读取异步传输任务状态，接受 signal 便于页面取消轮询。
   */
  transfer(id: string, options: RequestOptions = {}) { return this.get<TransferTask>(`/api/sys/transfers/${encodeURIComponent(id)}`, undefined, options); }
  /**
   * 列出当前可见传输任务，可按聚合筛选；不把任务列表当作业务数据导出结果。
   */
  transfers(aggregate?: string) { return this.get<TransferTask[]>('/api/sys/transfers', { aggregate }); }

  /**
   * 取得已完成导入的结构化报告；仅返回行结果与字段名，不返回原始单元格内容。
   */
  importReport(id: string) { return this.get<ImportReport>(`/api/sys/transfers/${encodeURIComponent(id)}/download`); }

  /** 下载使用 cookie 会话，不把凭据放入 URL；服务端会再次检查当前授权。 */
  /**
   * 构建传输结果下载地址，使用 Cookie 会话而非 URL 密钥；服务端在下载时重新检查当前权限和任务有效期。
   */
  transferDownloadUrl(id: string) { return this.url(`/api/sys/transfers/${encodeURIComponent(id)}/download`); }

  /**
   * 请求服务端注销，只有成功后清空本地会话并取消其余请求；失败保留状态供应用决定重试或提示。
   */
  async logout() {
    const r = await this.post('/auth/logout');
    if (r.ok) this.clearSession('logout');
    return r;
  }

  /**
   * 按可读聚合对象读取审批历史和当前步骤；不依赖用户是否有待办，详细裁决可见性由服务端过滤。
   */
  approvalHistory(aggregate: string, id: string, options?: RequestOptions) {
    return this.get<ApprovalHistory[]>(`/api/approval/history/${encodeURIComponent(aggregate)}/${encodeURIComponent(id)}`, undefined, options);
  }

  /** 读取本人待办及任务版本；pending 默认仅返回仍运行流程中的任务，结果不是全部业务记录。 */
  approvalTasks(status = 'pending', options?: RequestOptions) {
    return this.get<ApprovalTask[]>('/api/approval/tasks', { status }, options);
  }

  /** 查询当前可领取的候选池；返回不代表已经占用，使用 revision 提交 claim 后刷新本人待办。 */
  approvalCandidateTasks(options?: RequestOptions) {
    return this.get<ApprovalTask[]>('/api/approval/candidate-tasks', undefined, options);
  }

  /** 读取本人当前可见的站内提醒；游标为字符串，unreadOnly 只筛选未读，不修改服务端已读状态。 */
  approvalNotices(page: { after?: string; limit?: number; unreadOnly?: boolean } = {}, options?: RequestOptions) {
    return this.get<ApprovalNotices>('/api/approval/notices', page, options);
  }

  /** 将本人可见的单条提醒标记已读；重复调用保留首次已读时间，撤权或无关任务返回 NOT_FOUND。 */
  readApprovalNotice(id: string, options?: RequestOptions) {
    return this.post<{ id: string; readAt: string }, 'NOT_FOUND'>(`/api/approval/notices/${encodeURIComponent(id)}/read`, {}, options);
  }

  /** 查看当前本人发起且开放催办的运行实例；仅供展示，不授予业务读取或审批权限。 */
  approvalRequests(options?: RequestOptions) {
    return this.get<ApprovalRequest[]>('/api/approval/requests', undefined, options);
  }

  /**
   * 催办已读取的实例与节点，原因 1–1000 字；实例锁内检查申请人、对象版本、接收人及持久冷却。
   * 返回实际站内提醒接收人数与下次可催办时间；失败不自动重放，也不改变单据版本或审批结果。
   */
  urgeApproval(instanceId: string, input: { expectedStep: number; expectedSteps?: number[]; reason: string }, options?: RequestOptions) {
    return this.post<{ recipientCount: number; nextUrgeAt: string }, 'CONFLICT' | 'NOT_FOUND' | 'INVALID_TRANSITION' | 'RATE_LIMITED'>(
      `/api/approval/instances/${encodeURIComponent(instanceId)}/urge`, input, options);
  }

  /**
   * 提交领取/释放、转办、委派、归还或前后/并行加签；请求体只发送该动作的输入，路径参数单独编码。
   * expectedRevision 防重复变更；超时不能推断服务端未提交，应重读待办和历史，SDK 不自动重放。
   */
  approvalTaskAction(id: string, input: ApprovalTaskAction, options?: RequestOptions) {
    const { action, ...body } = input;
    const path = action === 'addSign' ? 'add-sign' : action;
    return this.post<ApprovalTaskActionResult, 'CONFLICT' | 'NOT_FOUND' | 'INVALID_TRANSITION'>(`/api/approval/tasks/${encodeURIComponent(id)}/${path}`, body, options);
  }

  /** 提交本人审批决定；要求显式使用读取到的 revision，受托未归还的任务会被拒绝。 */
  decideApprovalTask(id: string, outcome: 'approve' | 'reject' | 'return', input: { expectedRevision: number; comment?: string }, options?: RequestOptions) {
    return this.post<{ finished: boolean; outcome?: string }, 'CONFLICT' | 'NOT_FOUND' | 'INVALID_TRANSITION'>(`/api/approval/tasks/${encodeURIComponent(id)}/${outcome}`, input, options);
  }

  /** 跨单据审批轮次按 ID 游标读取操作记录；after 使用上页 nextCursor，默认 50、最多 200 条。 */
  approvalTaskHistory(process: string, aggregate: string, id: string, page: { after?: string; limit?: number } = {}, options?: RequestOptions) {
    return this.get<ApprovalTaskHistory>(`/api/approval/task-history/${encodeURIComponent(process)}/${encodeURIComponent(aggregate)}/${encodeURIComponent(id)}`, page, options);
  }
}

/** 默认实例 */
/**
 * 供生成契约和默认 hooks 共用的客户端单例。
 * 多服务或多独立会话场景可显式创建 CageClient，避免共享单例配置与登录状态。
 */
export const client = new CageClient();

/** React 订阅上传状态；task 由调用方持有并在卸载时 dispose，暂停会保留服务端分片。 */
/**
 * 通过 useSyncExternalStore 订阅指定上传任务的稳定快照。
 * hook 不拥有任务生命周期，调用方需在废弃时 dispose；暂停保留服务器分片以便恢复。
 */
export function useFileUpload(task: FileUploadTask) { return useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot); }

/**
 * 替换默认单例配置并返回该实例；配置切换会清空旧会话及取消请求，不创建新默认对象。
 */
export function configureClient(opts: ClientOptions): CageClient {
  client.configure(opts);
  return client;
}

// ---------------- 能力判断 ----------------

/**
 * 更新指定客户端的本地界面能力列表，保留当前用户并递增会话版本。
 * 仅用于受信任的身份装载/宿主集成，不能给服务器角色授予能力。
 */
export function setCapabilities(list: string[], c: CageClient = client): void {
  c.setSession(c.getSession().user, list);
}

/** 登录后调用一次（client.login 已自动调用） */
/**
 * 加载当前 Cookie 会话的用户和能力，只有请求前 revision 仍匹配时才写入本地状态。
 * 登录接口已自动调用；旧账户的慢响应不会覆盖后续账户，失败返回原 CageResult。
 */
export async function loadMe(c: CageClient = client) {
  const revision = c.getSession().revision;
  const r = await c.get<{ user: SessionUser | null; capabilities: string[] }>('/api/me');
  if (r.ok && revision === c.getSession().revision) c.setSession(r.data.user, r.data.capabilities);
  return r;
}

/**
 * 读取指定客户端当前用户摘要，未登录或已清空时为 null；不触发网络刷新。
 */
export const currentUser = (c: CageClient = client) => c.getSession().user;

/** 当前用户有没有某个能力点（只用于界面显示） */
/**
 * 便捷判断本地能力列表，默认使用单例；仅用于界面显示，不能替代服务器拒绝处理。
 */
export function can(capability: string, c: CageClient = client): boolean {
  return c.can(capability);
}

/** React：能力变化时自动重新渲染 */
/**
 * React 订阅能力变化并返回显示判断，服务端渲染快照保守为 false。
 * 只感知本地会话更新，不轮询服务器授权变化。
 */
export function useCan(capability: string, c: CageClient = client): boolean {
  return useSyncExternalStore(
    c.subscribe,
    () => c.can(capability),
    () => false,
  );
}

// ---------------- 查询 hooks（TanStack Query） ----------------

/**
 * 查询 hook 的失败异常，保留完整 CageResult，使 React Query 把业务失败置于错误分支。
 */
export class CageQueryError extends Error {
  /**
   * 用稳定错误码构造查询异常并保存响应诊断，不把失败结果塞进成功缓存。
   */
  constructor(readonly result: Extract<CageResult<unknown, string>, { ok: false }>) {
    super(result.code);
    this.name = 'CageQueryError';
  }
}

/**
 * 命令 Promise 的失败异常，带具体命令错误泛型和完整失败结果；用于保证 mutation 成功语义等于业务成功。
 */
export class CageCommandError<E extends string = string> extends Error {
  /**
   * 从失败命令结果构造异常，保留领域码、详情与请求 ID 供调用方展示或定位。
   */
  constructor(readonly result: Extract<CageResult<unknown, E>, { ok: false }>) {
    super(result.code);
    this.name = 'CageCommandError';
  }
}

/** React hook 与其他集成共用：只有业务成功结果才履行 Promise，业务失败统一进入异常分支。 */
/**
 * 把命令 CageResult Promise 转为成功数据，任何失败均抛 CageCommandError。
 * React hook 和非 React 调用方共用此语义，避免 HTTP 正常返回的业务拒绝误触发成功通知或缓存失效。
 */
export async function commandData<T, E extends string>(promise: Promise<CageResult<T, E>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new CageCommandError(result);
  return result.data;
}

/**
 * 通用列表分页结果，items 为当前页，total 为服务端可见总数。
 * page 从 1 开始，pageSize 是请求/响应页容量；不要用当前页长度替代 total。
 */
export interface Page<T> {
  /**
   * 当前页的已授权数据项。
   */
  items: T[];
  /**
   * 服务端返回的可见记录总数。
   */
  total: number;
  /**
   * 从 1 开始的当前页码。
   */
  page: number;
  /**
   * 当前页容量上限，不保证 items 一定填满。
   */
  pageSize: number;
}

/** 详情或任意 GET：响应用 schema 校验 */
/**
 * 用默认客户端执行 GET，查询参数纳入缓存键，失败抛 CageQueryError。
 * 可选 Zod schema 校验成功数据后再进入缓存；其余选项交给 TanStack Query，组件不直接处理网络 Cookie/CSRF。
 */
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
/**
 * 以参数参与缓存键读取通用 Page，支持 enabled 暂停尚未确定目标的查询。
 * 失败进入 Query 错误状态，可选 schema 逐项验证 items；分页、排序和过滤的真实合法性仍由服务端保证。
 */
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
/**
 * 将参数数组形式的命令封装为 mutation，先用 commandData 确认业务成功。
 * 只在成功后发起指定查询键的失效，不等待所有重取完成；失败不会触发 onSuccess 或伪造成功数据。
 */
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
/**
 * 按任务 ID 查询异步导入/导出状态，null 时禁用。
 * queued/processing/retrying 阶段每 2 秒刷新，完成、失败或过期停止；不包含任何固定页面，非 React 应用可直接 transfer。
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
