// 浏览器只在内存保留有界分片；恢复时逐片核对服务器校验和，不凭文件名/大小跳过内容。
import type { CageClient, CageResult, RequestOptions } from './index.js';

export interface UploadTarget { command: string; field: string; targetId?: string }
export interface UploadPart { number: number; bytes: number; sha256: string }
export interface UploadSession {
  id: string; aggregate: string; field: string; command: string; targetId: string | null;
  filename: string; bytes: number; contentType: string;
  status: 'uploading' | 'completing' | 'ready' | 'bound' | 'deleting' | 'deleted';
  partBytes: number; partCount: number; parts: UploadPart[]; expiresAt: string;
}
export interface FileInfo { id: string; filename: string; bytes: number; contentType: string }
export interface FileUploadOptions extends RequestOptions {
  uploadId?: string;
  concurrency?: number;
  retries?: number;
}
export interface FileUploadSnapshot {
  id: string | null;
  status: 'idle' | 'initializing' | 'verifying' | 'uploading' | 'paused' | 'completing' | 'completed' | 'failed' | 'cancelled';
  confirmedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  error: string | null;
}
export class FileUploadError extends Error {
  constructor(readonly result: Extract<CageResult<unknown, string>, { ok: false }>) { super(result.code); this.name = 'FileUploadError'; }
}
function data<T>(result: CageResult<T, string>): T { if (!result.ok) throw new FileUploadError(result); return result.data; }
function abortError() { return new DOMException('上传暂停', 'AbortError'); }
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class FileUploadTask {
  private snapshot: FileUploadSnapshot;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private running: Promise<UploadSession> | null = null;
  private readonly creationKey: string;
  private cancelled = false;
  private readonly unsubscribe: () => void;
  constructor(private readonly client: CageClient, private readonly file: File, private readonly target: UploadTarget, private readonly options: FileUploadOptions = {}) {
    this.creationKey = options.idempotencyKey ?? crypto.randomUUID();
    const concurrency = options.concurrency ?? 3, retries = options.retries ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6 || !Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error('上传并发为 1–6，重试次数为 0–10');
    this.snapshot = { id: options.uploadId ?? null, status: 'idle', confirmedBytes: 0, totalBytes: file.size, bytesPerSecond: 0, error: null };
    this.unsubscribe = client.subscribe((_session, reason) => { if (reason !== 'loaded') this.pause(); });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<FileUploadSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  pause() {
    if (this.running) { this.controller?.abort(); this.update({ status: 'paused', bytesPerSecond: 0 }); }
  }
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
  dispose() { this.pause(); this.unsubscribe(); }
  /** start 可在暂停/失败后再次调用；刷新后传 uploadId 创建新 task，并由用户重新选择原文件。 */
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
