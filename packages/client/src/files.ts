/**
 * 浏览器端私有文件分片上传与断点恢复任务。
 * CageClient 提供网络与会话取消，FileUploadTask 管理有界分片、校验和、并发及进度；完成上传只获得待绑定文件，业务命令仍负责最终事务内绑定。
 */
// 浏览器只在内存保留有界分片；恢复时逐片核对服务器校验和，不凭文件名/大小跳过内容。
import type { CageClient, CageResult, RequestOptions } from './index.js';

/**
 * 文件上传的业务目标，指向允许绑定的命令及 file/files 字段。
 * 新建对象可省略 targetId；更新已有对象应提供目标 ID，恢复时必须与服务端会话一致。
 */
export interface UploadTarget { /** 允许绑定文件的命令能力标识。 */ command: string; /** 命令所属聚合中的 file/files 字段名。 */ field: string; /** 可选已有业务对象 ID；新建时省略，服务端 DTO 用 null 表示。 */ targetId?: string }
/**
 * 服务端已确认分片摘要；number 从 1 开始，bytes 为字节数，sha256 为内容十六进制摘要，用于重选文件后的逐片核对。
 */
export interface UploadPart { /** 从 1 开始的分片编号，不是数组零基下标。 */ number: number; /** 该分片实际字节数，最后一片可小于 partBytes。 */ bytes: number; /** 服务端确认的分片 SHA-256 十六进制摘要。 */ sha256: string }
/**
 * 服务端上传会话状态与分片计划。
 * ready 表示字节合并完成，bound 才表示已经通过业务命令绑定；到期、删除和绑定状态不能继续作为普通待上传会话。
 */
export interface UploadSession {
  /**
   * 服务端上传会话 UUID，刷新恢复时保存此值。
   */
  id: string; /** 目标命令所属聚合名称。 */ aggregate: string; /** 待绑定文件字段。 */ field: string; /** 上传时已限定的目标命令。 */ command: string; /** 已有目标对象 ID；新建对象场景为 null。 */ targetId: string | null;
  /**
   * 服务端记录的原始文件名，恢复时与重选文件比较。
   */
  filename: string; /** 整文件声明字节数。 */ bytes: number; /** 声明的媒体类型，不由文件扩展名自动证明内容安全。 */ contentType: string;
  /**
   * 服务器生命周期状态，ready 与 bound 分别表示上传完成和业务绑定。
   */
  status: 'uploading' | 'completing' | 'ready' | 'bound' | 'deleting' | 'deleted';
  /**
   * 服务器给出的每片最大字节数。
   */
  partBytes: number; /** 计划总片数，应等于整文件大小除分片大小向上取整。 */ partCount: number; /** 服务器已确认的分片及其校验和。 */ parts: UploadPart[]; /** 会话到期 UTC 时间，过期不能继续上传。 */ expiresAt: string;
}
/**
 * 有权访问的私有文件元数据；不包含存储路径、公开对象地址或长期下载凭据。
 */
export interface FileInfo { /** 私有文件 ID，业务字段保存此值。 */ id: string; /** 下载展示文件名。 */ filename: string; /** 文件大小，单位字节。 */ bytes: number; /** 文件媒体类型。 */ contentType: string }
/**
 * 上传任务的网络、恢复和并发选项。
 * 继承 RequestOptions；concurrency 默认 3、允许 1 至 6，分片 retries 默认 4、允许 0 至 10，完成合并另有至少 8 次可恢复重试上限。
 */
export interface FileUploadOptions extends RequestOptions {
  /**
   * 恢复已有上传会话的 ID；省略时创建新会话。
   */
  uploadId?: string;
  /**
   * 并行分片 worker 数，默认 3，范围 1 至 6。
   */
  concurrency?: number;
  /**
   * 每分片可恢复失败的额外重试次数，默认 4，范围 0 至 10。
   */
  retries?: number;
}
/**
 * 供 UI 订阅的上传状态；进度只计服务端已确认字节，不按已发送网络字节推测完成。
 * completed 仅表示上传完成，业务字段绑定仍需命令提交。
 */
export interface FileUploadSnapshot {
  /**
   * 已创建或恢复的上传会话 ID；创建前为 null。
   */
  id: string | null;
  /**
   * 本地上传/验证/合并阶段及暂停、失败、取消状态。
   */
  status: 'idle' | 'initializing' | 'verifying' | 'uploading' | 'paused' | 'completing' | 'completed' | 'failed' | 'cancelled';
  /**
   * 已核对并获服务器确认的字节数。
   */
  confirmedBytes: number;
  /**
   * 浏览器选中文件总字节数。
   */
  totalBytes: number;
  /**
   * 本轮新确认字节的平均每秒速率；暂停和合并阶段为 0。
   */
  bytesPerSecond: number;
  /**
   * 供界面展示的当前失败文本；无失败或暂停时为 null。
   */
  error: string | null;
}
/**
 * 把失败 CageResult 包装成可抛出异常，保留稳定 code、detail、status 等诊断供界面处理。
 */
export class FileUploadError extends Error {
  /**
   * 从失败结果创建异常，不把失败响应当作上传成功元数据；原始 result 保留以便判断是否可恢复。
   */
  constructor(readonly result: Extract<CageResult<unknown, string>, { ok: false }>) { super(result.code); this.name = 'FileUploadError'; }
}
/**
 * 解包文件接口成功结果；失败统一抛 FileUploadError，供任务状态机分类和重试。
 */
function data<T>(result: CageResult<T, string>): T { if (!result.ok) throw new FileUploadError(result); return result.data; }
/**
 * 构造本地上传暂停的 AbortError；用于中断哈希与退避，不表示服务器已删除已上传分片。
 */
function abortError() { return new DOMException('上传暂停', 'AbortError'); }
/**
 * 带取消信号的重试等待，单位毫秒。
 * 完成或取消均移除监听器，取消清理定时器并抛暂停异常，避免暂停后继续发起下一分片。
 */
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * 可暂停、恢复、取消和订阅的单文件上传任务。
 * 持有浏览器 File，恢复时核对服务器已确认分片的 SHA-256；不凭同名同大小跳过校验，刷新后需应用保存 uploadId 并让用户重选文件。
 */
export class FileUploadTask {
  /**
   * 当前不可变订阅快照。
   */
  private snapshot: FileUploadSnapshot;
  /**
   * 本地快照订阅者，调用方取消订阅时移除。
   */
  private readonly listeners = new Set<() => void>();
  /**
   * 当前 start 的取消控制器；空闲时为 null。
   */
  private controller: AbortController | null = null;
  /**
   * 当前启动 Promise，用于合并重复 start 并等待暂停/取消收尾。
   */
  private running: Promise<UploadSession> | null = null;
  /**
   * 创建上传会话的稳定幂等键，防止首次请求重试生成多个会话。
   */
  private readonly creationKey: string;
  /**
   * 是否已进入明确取消流程，成功取消后阻止重新启动。
   */
  private cancelled = false;
  /**
   * 解除客户端会话订阅的清理函数。
   */
  private readonly unsubscribe: () => void;
  /**
   * 校验并发/重试范围，创建稳定会话幂等键和初始快照，并订阅会话变化以自动暂停。
   * 构造不发请求，options.uploadId 表示恢复已有服务端会话；调用方结束使用时应 dispose。
   */
  constructor(private readonly client: CageClient, private readonly file: File, private readonly target: UploadTarget, private readonly options: FileUploadOptions = {}) {
    this.creationKey = options.idempotencyKey ?? crypto.randomUUID();
    const concurrency = options.concurrency ?? 3, retries = options.retries ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6 || !Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error('上传并发为 1–6，重试次数为 0–10');
    this.snapshot = { id: options.uploadId ?? null, status: 'idle', confirmedBytes: 0, totalBytes: file.size, bytesPerSecond: 0, error: null };
    this.unsubscribe = client.subscribe((_session, reason) => { if (reason !== 'loaded') this.pause(); });
  }
  /**
   * 返回当前稳定快照供 useSyncExternalStore 读取，不复制或触发网络。
   */
  getSnapshot = () => this.snapshot;
  /**
   * 注册状态变化监听并返回解绑函数，不立即修改上传状态。
   */
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /**
   * 合并不可变快照并同步通知所有订阅者；只修改本地展示状态，不替代服务器分片确认。
   */
  private update(patch: Partial<FileUploadSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  /**
   * 中止当前本地上传并展示 paused，保留服务器已确认分片。
   * 没有正在运行的任务时不改变状态，之后可 start 重新验证并续传。
   */
  pause() {
    if (this.running) { this.controller?.abort(); this.update({ status: 'paused', bytesPerSecond: 0 }); }
  }
  /**
   * 先停止并等待当前上传，再通知服务器取消会话，成功后任务不可重新 start。
   * 服务器取消失败时恢复可重试标记并展示 failed，不谎报字节已经删除；没有创建会话时只取消本地任务。
   */
  async cancel() {
    this.cancelled = true; this.controller?.abort();
    await this.running?.catch(() => {});
    try {
      if (this.snapshot.id) data(await this.client.cancelUpload(this.snapshot.id));
      this.update({ status: 'cancelled', bytesPerSecond: 0, error: null });
    } catch (error) {
      this.cancelled = false;
      this.update({ status: 'failed', error: '取消失败，请重试。' });
      throw error;
    }
  }
  /**
   * 暂停当前操作并解除会话监听；不会主动删除服务器分片，适合组件卸载或任务实例废弃。
   */
  dispose() { this.pause(); this.unsubscribe(); }
  /** start 可在暂停/失败后再次调用；刷新后传 uploadId 创建新 task，并由用户重新选择原文件。 */
  /**
   * 启动或继续上传；并发调用复用同一个 Promise，已明确取消的任务拒绝启动。
   * 链接外部取消信号，失败时区分 paused 与 failed，finally 清理监听器和运行引用；刷新后可用相同 uploadId 创建新实例继续。
   */
  start(): Promise<UploadSession> {
    if (this.running) return this.running;
    if (this.cancelled) return Promise.reject(new Error('上传已取消'));
    const controller = new AbortController(); this.controller = controller;
    const externalAbort = () => controller.abort();
    this.options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (this.options.signal?.aborted) controller.abort();
    const run = this.run(controller.signal).catch(error => {
      const cancelled = controller.signal.aborted || (error instanceof FileUploadError && error.result.code === 'CANCELLED');
      this.update({ status: this.cancelled ? 'cancelled' : cancelled ? 'paused' : 'failed', bytesPerSecond: 0, error: cancelled ? null : String(error.message ?? error) });
      throw error;
    }).finally(() => { this.options.signal?.removeEventListener('abort', externalAbort); this.running = null; this.controller = null; });
    this.running = run;
    return run;
  }
  /**
   * 创建/恢复会话并核对文件名、字节数、业务目标、期限及分片计划，分片最多 64 MiB。
   * 先逐片 SHA-256 复核已确认内容，再由有界 worker 上传剩余片段；只有 NETWORK/TIMEOUT/RATE_LIMITED/CONFLICT 按指数退避重试。
   * 进度只增加确认字节，全部 worker 收尾后对同一会话幂等完成合并；返回 ready 会话不代表业务命令已绑定文件。
   */
  private async run(signal: AbortSignal): Promise<UploadSession> {
    this.update({ status: 'initializing', error: null, bytesPerSecond: 0 });
    const options = { signal, timeoutMs: this.options.timeoutMs ?? 120_000 };
    let session = this.snapshot.id
      ? data(await this.client.uploadSession(this.snapshot.id, options))
      : data(await this.client.beginUpload({ ...this.target, filename: this.file.name, bytes: this.file.size, contentType: this.file.type || 'application/octet-stream' }, { ...options, idempotencyKey: this.creationKey }));
    this.update({ id: session.id });
    if (signal.aborted) throw abortError();
    if (session.filename !== this.file.name || session.bytes !== this.file.size || session.command !== this.target.command || session.field !== this.target.field || session.targetId !== (this.target.targetId ?? null)) throw new Error('所选文件或业务目标与上传会话不一致');
    if (['deleting', 'deleted', 'bound'].includes(session.status) || new Date(session.expiresAt).getTime() <= Date.now()) throw new Error('上传会话已过期或不可继续');
    if (!Number.isSafeInteger(session.partBytes) || session.partBytes < 1 || session.partBytes > 64 * 1024 * 1024 || session.partCount !== Math.ceil(this.file.size / session.partBytes)) throw new Error('服务端分片参数非法');
    // 每次只把一个有界分片读入内存，计算前后都检查暂停信号；摘要用于核对内容，不以文件名/大小代替。
    const digest = async (blob: Blob) => {
      if (signal.aborted) throw abortError();
      const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      if (signal.aborted) throw abortError();
      return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    };
    const confirmed = new Map(session.parts.map(part => [part.number, part]));
    this.update({ status: 'verifying', confirmedBytes: 0 });
    let confirmedBytes = 0;
    for (const part of session.parts) {
      const start = (part.number - 1) * session.partBytes;
      const blob = this.file.slice(start, Math.min(start + session.partBytes, this.file.size));
      if (blob.size !== part.bytes || await digest(blob) !== part.sha256) throw new Error('所选文件与已上传分片内容不一致，请重新选择原文件');
      confirmedBytes += part.bytes;
      this.update({ confirmedBytes });
    }
    const queue = Array.from({ length: session.partCount }, (_, i) => i + 1).filter(number => !confirmed.has(number));
    if (session.status === 'ready') { this.update({ status: 'completed', confirmedBytes: this.file.size }); return session; }
    if (session.status === 'completing' && queue.length) throw new Error('服务端上传状态不一致');
    this.update({ status: 'uploading' });
    const started = Date.now(), initial = confirmedBytes;
    const retries = this.options.retries ?? 4;
    let failure: unknown;
    // 同一 JS 队列取走唯一分片号后独立上传；首个失败阻止继续领片，已发出的 worker 仍等待收尾，进度只累计确认成功的字节。
    const worker = async () => {
      while (queue.length && failure === undefined && !signal.aborted) {
        const number = queue.shift()!, start = (number - 1) * session.partBytes;
        const blob = this.file.slice(start, Math.min(start + session.partBytes, this.file.size));
        const sha256 = await digest(blob);
        for (let attempt = 0; ; attempt++) {
          const result = await this.client.uploadPart(session.id, number, blob, sha256, options);
          if (result.ok) break;
          if (attempt >= retries || !['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'CONFLICT'].includes(result.code)) throw new FileUploadError(result);
          await delay(Math.min(15_000, 1000 * 2 ** attempt) + Math.random() * 250, signal);
        }
        confirmedBytes += blob.size;
        this.update({ confirmedBytes, bytesPerSecond: (confirmedBytes - initial) / Math.max(0.001, (Date.now() - started) / 1000) });
      }
    };
    const workers = Array.from({ length: Math.min(this.options.concurrency ?? 3, Math.max(1, queue.length)) }, () => worker().catch(error => { failure ??= error; }));
    await Promise.all(workers);
    if (failure !== undefined) throw failure;
    if (signal.aborted) throw abortError();
    this.update({ status: 'completing', bytesPerSecond: 0 });
    // 合并请求超时也可能已成功；使用同一会话重试，服务端完成操作幂等。
    for (let attempt = 0; ; attempt++) {
      const result = await this.client.completeUpload(session.id, options);
      if (result.ok) { session = result.data; break; }
      if (attempt >= Math.max(retries, 8) || !['NETWORK', 'TIMEOUT', 'CONFLICT', 'RATE_LIMITED'].includes(result.code)) throw new FileUploadError(result);
      await delay(Math.min(30_000, 2000 * 2 ** attempt), signal);
    }
    this.update({ status: 'completed', confirmedBytes: this.file.size });
    return session;
  }
}
