// 上传会话/分片保存在 PostgreSQL；IO 在事务外执行，以 token 和租约阻止迟到结果回写。
import { randomUUID, createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';
import { cageError, isFile, type Ctx, type Kernel, type AnyField } from '@yss123/cage-kernel';
import { LocalFileStorage } from './local.js';
import type { ByteRange, FileStorage, StoredPart } from './storage.js';

export const beginUploadSchema = z.object({
  command: z.string().min(1).max(180), field: z.string().min(1).max(100), targetId: z.string().uuid().optional(),
  filename: z.string().min(1).max(255).refine(name => !/[\x00-\x1f\x7f/\\]/.test(name), '文件名不能包含路径或控制字符'),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), contentType: z.string().max(150),
});
export type BeginUpload = z.infer<typeof beginUploadSchema>;
export interface UploadPart { number: number; bytes: number; sha256: string }
export interface UploadSession {
  id: string; aggregate: string; field: string; command: string; targetId: string | null;
  filename: string; bytes: number; contentType: string;
  status: 'uploading' | 'completing' | 'ready' | 'bound' | 'deleting' | 'deleted';
  partBytes: number; partCount: number; parts: UploadPart[]; expiresAt: string;
}
export interface FileInfo { id: string; filename: string; bytes: number; contentType: string }
export interface FileServiceOptions {
  storage?: FileStorage;
  /** 默认 .cage-files；使用 storage 时由适配器决定目录。 */
  directory?: string;
  partBytes?: number;
  maxFileBytes?: number;
  maxPendingBytesPerUser?: number;
  maxStoredBytesPerTenant?: number;
  maxPendingUploadsPerUser?: number;
  retentionMs?: number;
  /** 单次分片/合并 IO 总时限，默认 30 分钟。 */
  ioTimeoutMs?: number;
}

type Row = Record<string, any>;
const SHA = /^[0-9a-f]{64}$/;
const LEASE_MS = 120_000;
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw);
  if (!result.success) throw cageError('INVALID_INPUT', result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
  return result.data;
};

export class FileService {
  readonly storage: FileStorage;
  readonly partBytes: number;
  readonly maxFileBytes: number;
  private readonly options: Required<Omit<FileServiceOptions, 'storage' | 'directory'>>;
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private closing = false;
  constructor(readonly kernel: Kernel, options: FileServiceOptions = {}) {
    this.storage = options.storage ?? new LocalFileStorage(options.directory);
    this.options = {
      partBytes: 16 * 1024 * 1024, maxFileBytes: 2 * 1024 ** 3,
      maxPendingBytesPerUser: 8 * 1024 ** 3, maxStoredBytesPerTenant: 100 * 1024 ** 3,
      maxPendingUploadsPerUser: 100, retentionMs: 86400_000, ioTimeoutMs: 1800_000,
      ...Object.fromEntries(Object.entries(options).filter(([k, v]) => k !== 'storage' && k !== 'directory' && v !== undefined)),
    };
    for (const [name, value] of Object.entries(this.options)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`[CAGE-FILE-001] ${name} 必须为正安全整数`);
    const limits = this.storage.limits;
    if (this.options.partBytes < limits.minPartBytes || this.options.partBytes > limits.maxPartBytes || Math.ceil(this.options.maxFileBytes / this.options.partBytes) > limits.maxParts)
      throw new Error('[CAGE-FILE-001] 分片配置超出存储适配器限制');
    this.partBytes = this.options.partBytes; this.maxFileBytes = this.options.maxFileBytes;
  }

  private identity(ctx: Ctx) {
    if (!ctx.userId || ctx.actor?.kind !== 'user') throw cageError('UNAUTHENTICATED');
  }
  private async policy(command: string, field: string, targetId: string | null, ctx: Ctx): Promise<AnyField> {
    this.identity(ctx);
    const registered = this.kernel.registry.command(command), definition = registered?.cmd;
    if (!registered || !definition?.invokedBy.includes('user') || definition.public) throw cageError('NOT_FOUND');
    if (!ctx.capabilities.has(command)) throw cageError('FORBIDDEN', { capability: command });
    const f = definition.agg.fields[field] as AnyField | undefined;
    // 上传入口必须明确关联一个能接收该字段的用户命令，不能借只读/无关命令获得暂存空间。
    if (!f || !isFile(f) || !(definition.input instanceof z.ZodObject) || !Object.hasOwn(definition.input.shape, field)) throw cageError('INVALID_INPUT', '目标命令未声明该文件输入字段');
    if (definition.from === 'new') {
      if (targetId) throw cageError('INVALID_INPUT', '新建附件会话不能指定已有对象');
    } else {
      if (!targetId) throw cageError('INVALID_INPUT', '修改附件需要目标对象 ID');
      const object = await this.kernel.read.get(definition.agg, targetId, ctx);
      if (!(definition.from as readonly string[]).includes(object.status)) throw cageError('INVALID_TRANSITION');
    }
    return f;
  }
  private async owned(id: string, ctx: Ctx): Promise<Row> {
    this.identity(ctx); parse(z.string().uuid(), id);
    const row = await this.kernel.app.selectFrom('sys.file_upload').selectAll().where('id', '=', id).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId).executeTakeFirst();
    if (!row || row.storage !== this.storage.name) throw cageError('NOT_FOUND');
    await this.policy(row.command_name, row.field_name, row.target_id, ctx);
    return row;
  }
  private async locked(tx: Transaction<any>, id: string, ctx: Ctx): Promise<Row> {
    const row = await tx.selectFrom('sys.file_upload').selectAll().where('id', '=', id).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId).forUpdate().executeTakeFirst();
    if (!row || row.storage !== this.storage.name) throw cageError('NOT_FOUND');
    return row;
  }
  private usable(row: Row) {
    if (new Date(row.expires_at) <= new Date() || ['deleting', 'deleted', 'bound'].includes(row.status)) throw cageError('CONFLICT', '上传会话已过期或不可修改');
  }
  private view(row: Row, parts: Row[]): UploadSession {
    return { id: row.id, aggregate: row.aggregate_name, field: row.field_name, command: row.command_name, targetId: row.target_id,
      filename: row.filename, bytes: Number(row.bytes), contentType: row.content_type, status: row.status,
      partBytes: row.part_bytes, partCount: row.part_count, expiresAt: new Date(row.expires_at).toISOString(),
      parts: parts.filter(p => p.storage_key).map(p => ({ number: p.number, bytes: p.bytes, sha256: p.sha256 })) };
  }
  private parts(id: string) { return this.kernel.app.selectFrom('sys.file_part').selectAll().where('upload_id', '=', id).orderBy('number').execute(); }

  async begin(raw: unknown, ctx: Ctx, idempotencyKey: string): Promise<UploadSession> {
    if (this.closing) throw cageError('CONFLICT', '文件服务正在停止');
    const request = parse(beginUploadSchema, raw);
    parse(z.string().min(1).max(200), idempotencyKey);
    const field = await this.policy(request.command, request.field, request.targetId ?? null, ctx);
    if (request.bytes > Math.min(field.filePolicy!.maxBytes, this.maxFileBytes) || !field.filePolicy!.accept.includes(request.contentType)) throw cageError('INVALID_INPUT', '文件大小或类型不符合字段限制');
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const row = await this.kernel.app.transaction().execute(async tx => {
      // 所有实例共用租户配额锁；只锁短元数据事务，不持有数据库事务传输字节。
      await sql`select pg_advisory_xact_lock(hashtextextended(${`cage:files:${ctx.tenantId}`}, 0))`.execute(tx);
      const existing = await tx.selectFrom('sys.file_upload').selectAll().where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
      if (existing) {
        if (existing.request_hash !== hash || existing.storage !== this.storage.name) throw cageError('CONFLICT', '幂等键已用于其他上传');
        return existing;
      }
      const quota = await sql<{ total: string; pending: string; count: string }>`select coalesce(sum(bytes),0) as total,
        coalesce(sum(bytes) filter (where user_id = ${ctx.userId}::uuid and status <> 'bound'),0) as pending,
        count(*) filter (where user_id = ${ctx.userId}::uuid and status <> 'bound') as count
        from sys.file_upload where tenant_id = ${ctx.tenantId}::uuid and status <> 'deleted'`.execute(tx);
      const usage = quota.rows[0];
      if (Number(usage.total) + request.bytes > this.options.maxStoredBytesPerTenant || Number(usage.pending) + request.bytes > this.options.maxPendingBytesPerUser || Number(usage.count) >= this.options.maxPendingUploadsPerUser)
        throw cageError('RATE_LIMITED', '文件存储或临时上传配额已满');
      return tx.insertInto('sys.file_upload').values({ id: randomUUID(), tenant_id: ctx.tenantId, user_id: ctx.userId,
        aggregate_name: this.kernel.registry.command(request.command)!.cmd.agg.name, field_name: request.field, command_name: request.command,
        target_id: request.targetId ?? null, filename: request.filename, content_type: request.contentType, bytes: request.bytes,
        part_bytes: this.partBytes, part_count: Math.ceil(request.bytes / this.partBytes), storage: this.storage.name, status: 'uploading',
        expires_at: new Date(Date.now() + this.options.retentionMs), idempotency_key: idempotencyKey, request_hash: hash }).returningAll().executeTakeFirstOrThrow();
    });
    return this.view(row, await this.parts(row.id));
  }

  async get(id: string, ctx: Ctx): Promise<UploadSession> { return this.view(await this.owned(id, ctx), await this.parts(id)); }
  async list(command: string, field: string, targetId: string | null, ctx: Ctx): Promise<UploadSession[]> {
    await this.policy(command, field, targetId, ctx);
    let query = this.kernel.app.selectFrom('sys.file_upload').selectAll().where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId)
      .where('command_name', '=', command).where('field_name', '=', field).where('storage', '=', this.storage.name).where('status', 'in', ['uploading', 'completing', 'ready']).where('expires_at', '>', new Date());
    query = targetId ? query.where('target_id', '=', targetId) : query.where('target_id', 'is', null);
    const rows = await query.orderBy('created_at', 'desc').limit(100).execute();
    // 列表只给会话摘要；恢复时 get 取得服务端确认的分片清单。
    return rows.map(row => this.view(row, []));
  }

  private lease<T>(renew: () => Promise<boolean>, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(cageError('CONFLICT', '文件服务正在停止'));
    const controller = new AbortController();
    let renewing = false;
    const timer = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try { if (!await renew()) controller.abort(); } catch { controller.abort(); } finally { renewing = false; }
    }, LEASE_MS / 4);
    const timeout = setTimeout(() => controller.abort(), this.options.ioTimeoutMs);
    const result = Promise.resolve().then(() => run(controller.signal)).finally(() => { clearInterval(timer); clearTimeout(timeout); this.active.delete(controller); });
    this.active.set(controller, result);
    return result;
  }

  async putPart(id: string, number: number, sha256: string, source: Readable, ctx: Ctx): Promise<UploadPart> {
    await this.owned(id, ctx);
    if (!SHA.test(sha256) || !Number.isInteger(number) || number < 1) throw cageError('INVALID_INPUT', '分片编号或 SHA-256 非法');
    const token = randomUUID();
    const claim = await this.kernel.app.transaction().execute(async tx => {
      const row = await this.locked(tx, id, ctx); this.usable(row);
      if (row.status !== 'uploading' || number > row.part_count) throw cageError('CONFLICT', '会话不能接收该分片');
      const bytes = number === row.part_count ? Number(row.bytes) - (number - 1) * row.part_bytes : row.part_bytes;
      const old = await tx.selectFrom('sys.file_part').selectAll().where('upload_id', '=', id).where('number', '=', number).executeTakeFirst();
      if (old?.storage_key) {
        if (old.sha256 !== sha256) throw cageError('CONFLICT', '相同片号的内容不一致');
        return { bytes, replay: true };
      }
      if (old?.lease_until && new Date(old.lease_until) > new Date()) throw cageError('CONFLICT', '分片正在上传');
      await tx.insertInto('sys.file_part').values({ upload_id: id, number, bytes, sha256, token, lease_until: new Date(Date.now() + LEASE_MS) })
        .onConflict(oc => oc.columns(['upload_id', 'number']).doUpdateSet({ bytes, sha256, token, storage_key: null, lease_until: new Date(Date.now() + LEASE_MS) })).execute();
      return { bytes, replay: false };
    });
    if (claim.replay) { source.resume(); return { number, bytes: claim.bytes, sha256 }; }
    try {
      return await this.lease(async () => {
        const updated = await this.kernel.app.updateTable('sys.file_part').set({ lease_until: new Date(Date.now() + LEASE_MS) }).where('upload_id', '=', id).where('number', '=', number).where('token', '=', token).where('storage_key', 'is', null).executeTakeFirst();
        return Number(updated.numUpdatedRows) === 1;
      }, async signal => {
        const key = await this.storage.writePart(id, token, source, { bytes: claim.bytes, sha256, signal });
        signal.throwIfAborted();
        await this.kernel.app.transaction().execute(async tx => {
          const row = await this.locked(tx, id, ctx); this.usable(row);
          if (row.status !== 'uploading') throw cageError('CONFLICT');
          const updated = await tx.updateTable('sys.file_part').set({ storage_key: key, lease_until: null }).where('upload_id', '=', id).where('number', '=', number).where('token', '=', token).executeTakeFirst();
          if (Number(updated.numUpdatedRows) !== 1) throw cageError('CONFLICT', '分片执行租约已失效');
        });
        return { number, bytes: claim.bytes, sha256 };
      });
    } catch (e) {
      source.destroy();
      await this.kernel.app.updateTable('sys.file_part').set({ lease_until: null }).where('upload_id', '=', id).where('number', '=', number).where('token', '=', token).where('storage_key', 'is', null).execute();
      throw e;
    }
  }

  private async verifyType(key: string, expected: string) {
    const stream = await this.storage.read(key, { start: 0, end: 8191 });
    const buffers: Buffer[] = [];
    try { for await (const chunk of stream) buffers.push(Buffer.from(chunk)); } finally { stream.destroy(); }
    const prefix = Buffer.concat(buffers);
    let detected: string | undefined;
    try { detected = (await fileTypeFromBuffer(prefix))?.mime; } catch { /* 短文本或截断头由下方保守判断。 */ }
    if (!detected && ['text/plain', 'text/csv', 'application/json'].includes(expected)) {
      try {
        // 前缀末尾可能落在 UTF-8 多字节字符中间，stream 模式不误拒绝合法边界。
        const text = new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: true });
        if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) detected = expected;
      } catch { /* 非 UTF-8 内容不视为文本。 */ }
    }
    if ((detected ?? 'application/octet-stream') !== expected) throw cageError('INVALID_INPUT', '文件内容与声明类型不一致');
  }

  async complete(id: string, ctx: Ctx): Promise<UploadSession> {
    const owned = await this.owned(id, ctx);
    // 已绑定后的重试不能重新合并或更改内容。
    if (owned.status === 'bound') return this.view(owned, []);
    const token = randomUUID();
    const claim = await this.kernel.app.transaction().execute(async tx => {
      const row = await this.locked(tx, id, ctx); this.usable(row);
      if (row.status === 'ready') return { row, parts: [] as Row[], replay: true };
      if (row.status === 'completing' && row.lease_until && new Date(row.lease_until) > new Date()) throw cageError('CONFLICT', '文件正在校验与合并');
      const parts = await tx.selectFrom('sys.file_part').selectAll().where('upload_id', '=', id).orderBy('number').execute();
      if (parts.length !== row.part_count || parts.some((p, i) => p.number !== i + 1 || !p.storage_key)) throw cageError('CONFLICT', '分片尚未全部完成');
      await tx.updateTable('sys.file_upload').set({ status: 'completing', operation_token: token, lease_until: new Date(Date.now() + LEASE_MS) }).where('id', '=', id).execute();
      return { row, parts, replay: false };
    });
    if (claim.replay) return this.view(claim.row, await this.parts(id));
    try {
      return await this.lease(async () => {
        const updated = await this.kernel.app.updateTable('sys.file_upload').set({ lease_until: new Date(Date.now() + LEASE_MS) }).where('id', '=', id).where('status', '=', 'completing').where('operation_token', '=', token).executeTakeFirst();
        return Number(updated.numUpdatedRows) === 1;
      }, async signal => {
        const parts: StoredPart[] = claim.parts.map(p => ({ number: p.number, bytes: p.bytes, sha256: p.sha256, key: p.storage_key }));
        await this.verifyType(parts[0].key, claim.row.content_type);
        const key = await this.storage.complete(id, token, parts, { bytes: Number(claim.row.bytes), signal });
        signal.throwIfAborted();
        const row = await this.kernel.app.transaction().execute(async tx => {
          const row = await this.locked(tx, id, ctx); this.usable(row);
          if (row.status !== 'completing' || row.operation_token !== token) throw cageError('CONFLICT');
          return tx.updateTable('sys.file_upload').set({ status: 'ready', storage_key: key, operation_token: null, lease_until: null })
            .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        });
        return this.view(row, claim.parts);
      });
    } catch (e) {
      await this.kernel.app.updateTable('sys.file_upload').set({ status: 'uploading', operation_token: null, lease_until: null }).where('id', '=', id).where('status', '=', 'completing').where('operation_token', '=', token).execute();
      throw e;
    }
  }

  async cancel(id: string, ctx: Ctx) {
    await this.owned(id, ctx);
    await this.kernel.app.transaction().execute(async tx => {
      const row = await this.locked(tx, id, ctx);
      if (row.status === 'bound') throw cageError('CONFLICT', '已绑定附件必须通过业务命令移除');
      await tx.updateTable('sys.file_upload').set({ status: row.status === 'deleted' ? 'deleted' : 'deleting', expires_at: new Date(), operation_token: null }).where('id', '=', id).execute();
    });
    return { ok: true };
  }

  private async accessible(id: string, ctx: Ctx): Promise<Row> {
    this.identity(ctx); parse(z.string().uuid(), id);
    const row = await this.kernel.app.selectFrom('sys.file_upload').selectAll().where('id', '=', id).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
    if (!row || row.storage !== this.storage.name || !row.storage_key) throw cageError('NOT_FOUND');
    if (row.status === 'bound') {
      const aggregate = this.kernel.registry.aggregate(row.aggregate_name), field = aggregate?.fields[row.field_name] as AnyField | undefined;
      if (!aggregate || !field || !isFile(field)) throw cageError('NOT_FOUND');
      const object = await this.kernel.read.get(aggregate, row.bound_id, ctx);
      const value = object[row.field_name];
      if (!(Array.isArray(value) ? value.includes(id) : value === id)) throw cageError('NOT_FOUND');
    } else {
      if (row.status !== 'ready' || row.user_id !== ctx.userId || new Date(row.expires_at) <= new Date()) throw cageError('NOT_FOUND');
      await this.policy(row.command_name, row.field_name, row.target_id, ctx);
    }
    return row;
  }
  async info(id: string, ctx: Ctx): Promise<FileInfo> {
    const row = await this.accessible(id, ctx);
    return { id: row.id, filename: row.filename, bytes: Number(row.bytes), contentType: row.content_type };
  }
  async download(id: string, ctx: Ctx, range?: ByteRange) {
    const row = await this.accessible(id, ctx), bytes = Number(row.bytes);
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= bytes)) throw cageError('INVALID_INPUT', '下载范围非法');
    await this.kernel.app.transaction().execute(async tx => {
      // 与解绑/清理串行决定是否交付；权限使用当前请求上下文，下载从不携带持久 bearer URL。
      const current = await tx.selectFrom('sys.file_upload').selectAll().where('id', '=', id).where('tenant_id', '=', ctx.tenantId).forUpdate().executeTakeFirstOrThrow();
      if (current.status !== row.status || current.bound_id !== row.bound_id || (current.status !== 'bound' && new Date(current.expires_at) <= new Date())) throw cageError('NOT_FOUND');
      await this.kernel.writeAudit(tx, { tenantId: ctx.tenantId, actor: ctx.actor!.id, actorKind: 'user', source: ctx.source,
        kind: 'read', capability: `${row.aggregate_name}.read`, aggregate: row.aggregate_name, aggregateId: row.bound_id,
        result: 'ok', diff: { fileId: id, field: row.field_name, operation: 'file.download', ...(range ? { range } : {}) }, requestId: ctx.requestId });
    });
    return { info: { id, filename: row.filename, bytes, contentType: row.content_type }, stream: await this.storage.read(row.storage_key, range) };
  }

  /** API 后台周期调用；数据库先认领，再在事务外删除。保留墓碑以回收迟到 IO 的残留文件。 */
  async cleanup(limit = 100): Promise<void> {
    const now = new Date();
    const candidates = await this.kernel.app.selectFrom('sys.file_upload').select('id').where('storage', '=', this.storage.name)
      .where('status', 'in', ['uploading', 'completing', 'ready', 'deleting', 'deleted']).where('expires_at', '<=', now).orderBy('expires_at').limit(limit).execute();
    for (const candidate of candidates) {
      const claimed = await this.kernel.app.transaction().execute(async tx => {
        const row = await tx.selectFrom('sys.file_upload').selectAll().where('id', '=', candidate.id).forUpdate().executeTakeFirstOrThrow();
        if (row.status === 'bound' || new Date(row.expires_at) > now || (row.lease_until && new Date(row.lease_until) > now)) return false;
        const inFlight = await tx.selectFrom('sys.file_part').select('number').where('upload_id', '=', row.id).where('lease_until', '>', now).limit(1).executeTakeFirst();
        if (inFlight) return false;
        await tx.updateTable('sys.file_upload').set({ status: 'deleting', operation_token: null }).where('id', '=', row.id).execute();
        return true;
      });
      if (!claimed) continue;
      await this.storage.remove(candidate.id);
      // 墓碑每天复查，避免大量旧墓碑占满每一轮待清理队列。
      await this.kernel.app.updateTable('sys.file_upload').set({ status: 'deleted', storage_key: null, expires_at: new Date(Date.now() + 86400_000) }).where('id', '=', candidate.id).where('status', '=', 'deleting').execute();
    }
    const completed = await this.kernel.app.selectFrom('sys.file_upload').select(['id', 'storage_key']).where('storage', '=', this.storage.name).where('status', 'in', ['ready', 'bound']).where('storage_key', 'is not', null)
      .where(eb => eb.or([eb('pruned_at', 'is', null), eb('pruned_at', '<', new Date(Date.now() - 86400_000))]))
      .orderBy(sql`pruned_at asc nulls first`).limit(limit).execute();
    for (const row of completed) {
      await this.storage.prune(row.id, row.storage_key);
      await this.kernel.app.updateTable('sys.file_upload').set({ pruned_at: new Date() }).where('id', '=', row.id).execute();
    }
  }

  async close() {
    this.closing = true;
    const work = [...this.active];
    for (const [controller] of work) controller.abort();
    await Promise.allSettled(work.map(([, promise]) => promise));
  }
}
