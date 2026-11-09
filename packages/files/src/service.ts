// 上传会话/分片保存在 PostgreSQL；IO 在事务外执行，以 token 和租约阻止迟到结果回写。
/** 本文件连接业务授权、上传元数据和私有存储，负责 begin → 分片 → complete → ready 的生命周期。
 * ready 只表示字节已完成，真正绑定由业务命令在自己的事务中完成；服务不直接修改领域对象。
 * 配额和状态在短数据库事务中决定，长时间 IO 通过续租与 token 栅栏保护，清理保留墓碑兜住迟到写入。
 */
import { randomUUID, createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';
import { cageError, isFile, type Ctx, type Kernel, type AnyField } from '@yss123/cage-kernel';
import { LocalFileStorage } from './local.js';
import type { ByteRange, FileStorage, StoredPart } from './storage.js';

/** 创建上传的外部输入：命令/字段定位授权边界，targetId 仅用于修改已有对象。
 * bytes 为正安全整数字节数；filename 仅作下载展示，禁止路径和控制字符；contentType 后续还会验内容。
 */
export const beginUploadSchema = z.object({
  command: z.string().min(1).max(180), field: z.string().min(1).max(100), targetId: z.string().uuid().optional(),
  filename: z.string().min(1).max(255).refine(name => !/[\x00-\x1f\x7f/\\]/.test(name), '文件名不能包含路径或控制字符'),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), contentType: z.string().max(150),
});
/** 通过创建校验后的输入类型；不包含服务端生成的会话 ID、租约或存储路径。 */
export type BeginUpload = z.infer<typeof beginUploadSchema>;
/** 已完成分片的公开证明；number 从 1 开始，摘要用于断点续传时确认内容一致。 */
export interface UploadPart { number: number; bytes: number; sha256: string }
/** 浏览器可见的上传进度。它不泄露存储键，也不能作为永久下载凭据。 */
export interface UploadSession {
  /** 会话与业务入口；targetId 在新建对象场景为 null，绑定后仍保留原上传语境。 */
  id: string; aggregate: string; field: string; command: string; targetId: string | null;
  /** 展示文件名、精确总字节数和声明的 MIME；不代表客户端可指定物理存储位置。 */
  filename: string; bytes: number; contentType: string;
  /** ready 可交给命令绑定；bound 只能通过业务命令解绑；deleting/deleted 不再接收上传。 */
  status: 'uploading' | 'completing' | 'ready' | 'bound' | 'deleting' | 'deleted';
  /** 标准片大小、总片数、已确认片以及 ISO 到期时间；列表摘要的 parts 刻意为空。 */
  partBytes: number; partCount: number; parts: UploadPart[]; expiresAt: string;
}
/** 经过当前权限检查后返回的文件描述，不包含可绕过权限的存储 URL。 */
export interface FileInfo { id: string; filename: string; bytes: number; contentType: string }
/** 单服务实例的存储策略。所有数值均须为正安全整数，并在构造时校验适配器容量限制。 */
export interface FileServiceOptions {
  /** 可替换的私有存储；未提供时使用 LocalFileStorage。 */
  storage?: FileStorage;
  /** 默认 .cage-files；使用 storage 时由适配器决定目录。 */
  directory?: string;
  /** 标准分片字节数，默认 16 MiB；最后一片按剩余长度收尾。 */
  partBytes?: number;
  /** 每文件服务级字节上限，默认 2 GiB；还须满足业务字段自身限制。 */
  maxFileBytes?: number;
  /** 单用户未绑定会话累计字节上限，默认 8 GiB。 */
  maxPendingBytesPerUser?: number;
  /** 租户所有未删除会话累计声明字节上限，默认 100 GiB。 */
  maxStoredBytesPerTenant?: number;
  /** 单用户未绑定会话个数上限，默认 100；与字节配额共同限制占用。 */
  maxPendingUploadsPerUser?: number;
  /** 暂存保留时间，单位毫秒，默认一天；过期内容由后台清理回收。 */
  retentionMs?: number;
  /** 单次分片/合并 IO 总时限，默认 30 分钟。 */
  ioTimeoutMs?: number;
}

type Row = Record<string, any>;
const SHA = /^[0-9a-f]{64}$/;
/** IO 租约窗口为两分钟，活动操作每四分之一窗口续租；与完整 IO 总时限分别控制失联和超时。 */
const LEASE_MS = 120_000;
/** 将 Zod 的路径化问题统一转换为公开 INVALID_INPUT，避免把 Zod 异常细节直接暴露给 HTTP。 */
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw);
  if (!result.success) throw cageError('INVALID_INPUT', result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
  return result.data;
};

/** 文件业务边界的协调器；实例由 API 生命周期管理，close 会取消并等待本实例在途 IO。
 * 每次访问重新检查当前身份和策略，不把创建会话时的授权当作后续读写的永久许可。
 */
export class FileService {
  /** 持久字节适配器；名称同时写入会话，防止跨存储空间误读或误清理。 */
  readonly storage: FileStorage;
  /** 已通过适配器限制校验的分片字节数，供 HTTP 层设置请求体限制。 */
  readonly partBytes: number;
  /** 服务级文件大小上限，单位字节。 */
  readonly maxFileBytes: number;
  private readonly options: Required<Omit<FileServiceOptions, 'storage' | 'directory'>>;
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private closing = false;
  /** 合并默认策略并做启动期配置校验；不创建上传、不访问存储、不启动定时清理。 */
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

  /** 上传/下载入口仅接受具名 user 身份；流程、任务及匿名上下文不能借此占用私有存储。 */
  private identity(ctx: Ctx) {
    if (!ctx.userId || ctx.actor?.kind !== 'user') throw cageError('UNAUTHENTICATED');
  }
  /** 验证命令能力、文件字段及输入归属；已有对象还要通过当前 read 范围和起始状态检查。
   * 这里只判断上传资格，最终业务命令仍会独立检查版本、硬约束、不变量和绑定合法性。
   */
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
  /** 取得当前租户当前上传者的会话，并重新校验业务策略；不存在或存储不匹配统一隐藏为 NOT_FOUND。 */
  private async owned(id: string, ctx: Ctx): Promise<Row> {
    this.identity(ctx); parse(z.string().uuid(), id);
    const row = await this.kernel.app.selectFrom('sys.file_upload').selectAll().where('id', '=', id).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId).executeTakeFirst();
    if (!row || row.storage !== this.storage.name) throw cageError('NOT_FOUND');
    await this.policy(row.command_name, row.field_name, row.target_id, ctx);
    return row;
  }
  /** 在调用方事务中锁会话行，串行化修改、完成和取消；调用方应已用 owned/policy 完成授权。 */
  private async locked(tx: Transaction<any>, id: string, ctx: Ctx): Promise<Row> {
    const row = await tx.selectFrom('sys.file_upload').selectAll().where('id', '=', id).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId).forUpdate().executeTakeFirst();
    if (!row || row.storage !== this.storage.name) throw cageError('NOT_FOUND');
    return row;
  }
  /** 可修改性检查与授权分离；过期、已绑定或进入删除阶段的会话不允许迟到写入重新激活。 */
  private usable(row: Row) {
    if (new Date(row.expires_at) <= new Date() || ['deleting', 'deleted', 'bound'].includes(row.status)) throw cageError('CONFLICT', '上传会话已过期或不可修改');
  }
  /** 将数据库 bigint/日期与内部状态投影成公开 DTO，只列出确实已有存储键的已确认分片。 */
  private view(row: Row, parts: Row[]): UploadSession {
    return { id: row.id, aggregate: row.aggregate_name, field: row.field_name, command: row.command_name, targetId: row.target_id,
      filename: row.filename, bytes: Number(row.bytes), contentType: row.content_type, status: row.status,
      partBytes: row.part_bytes, partCount: row.part_count, expiresAt: new Date(row.expires_at).toISOString(),
      parts: parts.filter(p => p.storage_key).map(p => ({ number: p.number, bytes: p.bytes, sha256: p.sha256 })) };
  }
  /** 按片号返回内部元数据；仅供已完成所有权检查的调用使用，不能直接作为公开查询入口。 */
  private parts(id: string) { return this.kernel.app.selectFrom('sys.file_part').selectAll().where('upload_id', '=', id).orderBy('number').execute(); }

  /** 创建或重放同一次上传申请。租户咨询锁让多实例在同一短事务内核对并占用配额。
   * 相同用户的同一幂等键只能对应相同规范请求和存储；超配额抛 RATE_LIMITED，不产生半成品会话。
   * 此步骤只预留元数据与额度，客户端之后使用返回的 partBytes/partCount 上传字节。
   */
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

  /** 断点恢复的权威进度查询；返回服务端已确认片清单，客户端不能凭本地发送进度认定上传成功。 */
  async get(id: string, ctx: Ctx): Promise<UploadSession> { return this.view(await this.owned(id, ctx), await this.parts(id)); }
  /** 查询同一业务入口下本人未过期的可恢复会话，最多一百条；摘要不携带完整分片表。 */
  async list(command: string, field: string, targetId: string | null, ctx: Ctx): Promise<UploadSession[]> {
    await this.policy(command, field, targetId, ctx);
    let query = this.kernel.app.selectFrom('sys.file_upload').selectAll().where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId)
      .where('command_name', '=', command).where('field_name', '=', field).where('storage', '=', this.storage.name).where('status', 'in', ['uploading', 'completing', 'ready']).where('expires_at', '>', new Date());
    query = targetId ? query.where('target_id', '=', targetId) : query.where('target_id', 'is', null);
    const rows = await query.orderBy('created_at', 'desc').limit(100).execute();
    // 列表只给会话摘要；恢复时 get 取得服务端确认的分片清单。
    return rows.map(row => this.view(row, []));
  }

  /** 为事务外 IO 管理续租、总时限与停机取消。
   * 续租丢失或数据库异常即中止信号；run 必须在提交元数据前再次检查信号和 token，避免迟到完成覆盖新执行者。
   * active 持有 Promise 直到 finally，用于 close 等待真正停止，而非仅发出取消请求。
   */
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

  /** 上传一片：先锁会话认领片号，再释放事务写存储，最后凭 token 确认结果。
   * 相同片号和摘要的已完成请求可重放；内容变化或有效租约冲突会拒绝。尾片长度从总大小计算。
   * IO 失败会销毁输入流并释放属于本 token 的租约，已被其他执行接管的记录保持不动。
   */
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

  /** 最多读取首片前 8192 字节检查 MIME；文本仅接受合法 UTF-8 和允许的控制字符。
   * 这是内容类型核对，不是病毒扫描，也不会验证整个 JSON/CSV 的业务格式。
   */
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

  /** 确认片号连续且全部落盘后认领合并租约，验证类型并生成最终对象，再原子进入 ready。
   * ready/bound 的重放不重复合并；失败只回退本次 token 仍持有的 completing 状态，允许后续安全恢复。
   * 返回 ready 后仍需由调用方执行目标业务命令绑定附件，不能把上传成功当作业务保存成功。
   */
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

  /** 标记未绑定会话待删除并使执行 token 失效；实际字节回收交给 cleanup，故返回不表示磁盘已清空。 */
  async cancel(id: string, ctx: Ctx) {
    await this.owned(id, ctx);
    await this.kernel.app.transaction().execute(async tx => {
      const row = await this.locked(tx, id, ctx);
      if (row.status === 'bound') throw cageError('CONFLICT', '已绑定附件必须通过业务命令移除');
      await tx.updateTable('sys.file_upload').set({ status: row.status === 'deleted' ? 'deleted' : 'deleting', expires_at: new Date(), operation_token: null }).where('id', '=', id).execute();
    });
    return { ok: true };
  }

  /** 下载授权：已绑定文件必须仍存在于当前可读业务对象的对应字段；ready 暂存只允许上传者访问。
   * 每次重新读取对象与范围，隐藏字段/撤权/解绑均可能使文件不可见，不依赖曾经拿到的文件 ID。
   */
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
  /** 返回授权后的展示元数据；不创建内容流，下载调用仍须再次检查并可靠审计。 */
  async info(id: string, ctx: Ctx): Promise<FileInfo> {
    const row = await this.accessible(id, ctx);
    return { id: row.id, filename: row.filename, bytes: Number(row.bytes), contentType: row.content_type };
  }
  /** 在当前权限下读取完整文件或闭区间，并在交付流之前提交下载审计。
   * 事务内锁会话再次核对绑定/到期状态，与解绑清理排序；审计失败即拒绝交付，不降级为未审计下载。
   * 返回的 stream 由 HTTP 层消费；存储读取失败会直接上抛，内容不在数据库事务内传输。
   */
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

  /** API 后台周期调用；数据库先认领，再在事务外删除。保留墓碑以回收迟到 IO 的残留文件。
   * 每轮最多处理 limit 个过期会话及 limit 个已完成对象；有效合并/分片租约会推迟删除。
   * 删除失败保留 deleting 供下轮重试；墓碑一天后重查，已完成对象则只回收其非最终分片。
   */
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

  /** 阻止新 IO，向所有本实例在途操作发出取消并等待收尾；单个取消异常不妨碍等待其他操作。 */
  async close() {
    this.closing = true;
    const work = [...this.active];
    for (const [controller] of work) controller.abort();
    await Promise.allSettled(work.map(([, promise]) => promise));
  }
}
