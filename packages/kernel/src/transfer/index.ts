// 导入/导出是内核提供的任务服务，不增加领域原语。业务数据仍只经过安全读侧或命令。
// outbox 消费事务同时提交导入写入、逐行结果和任务状态：进程崩溃时一起回滚，重投不重复导入。
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { cageError, toCageError } from '../errors.js';
import type { Kernel } from '../kernel.js';
import { loadUserGrants, userCtx } from '../org.js';
import type { Ctx } from '../types.js';
import { stableStringify } from '../util/names.js';
import { traceCarrier } from '../telemetry.js';
import type { EventConsumer } from '../worker/outbox.js';
import { csvInputs, importShape } from './csv.js';

const EVENT = 'cage:DataTransferRequested';
const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
export const importRequestSchema = z.object({ command: z.string(), csv: z.string(), atomic: z.boolean().default(false) }).strict();

/** 对外任务视图；queued/processing/retrying 只是进度，只有 completed 才能尝试下载结果。 */
export interface TransferTask {
  id: string;
  kind: 'export' | 'import';
  target: string;
  status: 'queued' | 'processing' | 'retrying' | 'completed' | 'failed' | 'expired';
  createdAt: string;
  expiresAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  /** 只存计数和文件元数据；结果可过期为 null，不包含导入输入或命令返回的业务快照。 */
  result: { rows: number; succeeded?: number; failed?: number; filename?: string; atomic?: boolean } | null;
}

function requireUser(ctx: Ctx): string {
  if (ctx.actor?.kind !== 'user' || !ctx.userId) throw cageError('UNAUTHENTICATED');
  return ctx.userId;
}

function requireCap(ctx: Ctx, capability: string) {
  if (!ctx.capabilities.has(capability)) throw cageError('FORBIDDEN', { capability });
}

/** 排队、执行、下载都重读有效授权，防止任务排队期间撤权后继续沿用旧权限。 */
async function liveContext(k: Kernel, userId: string, tenantId: string, db: Kysely<any> = k.app): Promise<Ctx> {
  const grants = await loadUserGrants(db, userId, tenantId);
  if (!grants?.active) throw cageError('FORBIDDEN', '用户已被禁用或删除');
  return userCtx(grants);
}

/** 只有已注册、可由用户调用且对象输入可映射 CSV 的命令才能导入，仍逐行走完整写流水线。 */
function importCommand(k: Kernel, capability: string, ctx: Ctx) {
  const command = k.registry.command(capability);
  if (!command || !command.cmd.invokedBy.includes('user')) throw cageError('NOT_FOUND');
  requireCap(ctx, capability);
  importShape(command.cmd.input);
  return command;
}

/** 下载不能沿用排队时保存的授权。范围、明文权限或部门树变化后，旧文件必须重新生成。 */
async function accessHash(k: Kernel, ctx: Ctx, aggregate: string, db: Kysely<any> = k.app) {
  const depts = await db.selectFrom('sys.dept').select(['id', 'ancestors', 'status'])
    .where('tenant_id', '=', ctx.tenantId).orderBy('id').execute();
  return hash({ user: ctx.userId, dept: ctx.deptId, path: ctx.deptPath, scopes: ctx.scopes[aggregate] ?? ctx.scopes['*'], unmask: [...ctx.unmask].sort(), depts });
}

/**
 * 原始文件和文件内容不会出现在列表、审计 diff 或 outbox 中。
 * 队列只携带任务 id；任务查询始终绑定租户和提交人，运维权限也不能下载别人的文件。
 */
export class DataTransfers {
  constructor(private readonly k: Kernel) {}

  /** 校验当前导出能力后入队；返回任务而非文件，实际范围读取由 worker 再次鉴权执行。 */
  async export(aggregate: string, params: Record<string, unknown>, ctx: Ctx, key: string) {
    const user = requireUser(ctx), current = await liveContext(this.k, user, ctx.tenantId);
    if (!this.k.registry.aggregate(aggregate)) throw cageError('NOT_FOUND');
    requireCap(current, `${aggregate}.export`);
    return this.enqueue('export', aggregate, params, ctx, key);
  }

  /** 提交时先拒绝坏 CSV 结构，单行业务错误留在任务报告；二次认证时间随任务保存供执行检查。 */
  async import(request: unknown, ctx: Ctx, key: string) {
    const user = requireUser(ctx), current = await liveContext(this.k, user, ctx.tenantId);
    const parsed = importRequestSchema.safeParse(request);
    if (!parsed.success) throw cageError('INVALID_INPUT', '需要 command、csv 和可选的 atomic 参数');
    const { command, csv, atomic } = parsed.data;
    const rc = importCommand(this.k, command, current);
    // 文件格式错误立即反馈；单行输入或业务错误留给命令校验，在任务结果中报告。
    csvInputs(csv, rc.cmd.input);
    return this.enqueue('import', command, { csv, atomic, stepUpAt: ctx.stepUpAt ?? null }, ctx, key);
  }

  /**
   * 用事务咨询锁串行化同一租户/用户/幂等键，内容摘要不符即 CONFLICT，重复内容返回已有任务。
   * 新任务、outbox 和提交审计共同提交；队列只保存 taskId，CSV/查询输入仅在受控任务记录中保存。
   */
  private async enqueue(kind: 'export' | 'import', target: string, input: object, ctx: Ctx, key: string): Promise<TransferTask> {
    if (!key || key.length > 200) throw cageError('INVALID_INPUT', '请提供不超过 200 字符的 Idempotency-Key');
    // 二次认证时间属于会话上下文，不属于用户提交的文件；重试时不要因此误报冲突。
    const { stepUpAt: _, ...requestInput } = input as Record<string, unknown>;
    const requestHash = hash({ kind, target, input: requestInput });
    const id = await this.k.app.transaction().execute(async (tx) => {
      const lockKey = `${ctx.tenantId}:${ctx.userId}:${key}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(tx);
      const previous = await tx.selectFrom('sys.data_transfer').select(['id', 'request_hash'])
        .where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId).where('idempotency_key', '=', key).executeTakeFirst();
      if (previous) {
        if (previous.request_hash !== requestHash) throw cageError('CONFLICT', '同一幂等键不能提交不同的任务');
        return previous.id as string;
      }
      const taskId = randomUUID();
      const outbox = await tx.insertInto('sys.outbox').values({
        tenant_id: ctx.tenantId, event: EVENT, aggregate: 'DataTransfer', aggregate_id: taskId,
        payload: JSON.stringify({ taskId }), actor: JSON.stringify(ctx.actor), trace: JSON.stringify(traceCarrier()), request_id: ctx.requestId ?? null,
      }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('sys.data_transfer').values({
        id: taskId, tenant_id: ctx.tenantId, user_id: ctx.userId, kind, target,
        idempotency_key: key, request_hash: requestHash, input: JSON.stringify(input), outbox_id: outbox.id,
      }).execute();
      await this.k.writeAudit(tx, {
        tenantId: ctx.tenantId, actor: ctx.userId!, actorKind: 'user', source: kind === 'import' ? 'import' : 'api', kind: 'ops',
        capability: kind === 'export' ? `${target}.export` : target, command: `dataTransfer.${kind}`, result: 'queued',
        diff: { taskId }, requestId: ctx.requestId ?? null,
      });
      await sql`select pg_notify('cage_outbox', '')`.execute(tx);
      return taskId;
    });
    return this.get(id, ctx);
  }

  /** 所有任务查询先固定租户和提交人；系统运维权限不赋予读取他人文件的隐含通道。 */
  private own(ctx: Ctx) {
    return this.k.app.selectFrom('sys.data_transfer as t').innerJoin('sys.outbox as o', 'o.id', 't.outbox_id')
      .where('t.tenant_id', '=', ctx.tenantId).where('t.user_id', '=', requireUser(ctx));
  }

  /** 返回本人最近 100 个匹配任务；聚合筛选覆盖该对象的导出和各命令导入。 */
  async list(ctx: Ctx, aggregate?: string): Promise<TransferTask[]> {
    let query = this.own(ctx);
    // 业务列表只需要当前对象的任务；先在数据库筛选再取最近 100 条，
    // 避免其他页面的任务把当前对象的记录挤出结果集。
    if (aggregate) {
      if (!this.k.registry.aggregate(aggregate)) throw cageError('NOT_FOUND');
      query = query.where((eb) => eb.or([eb('t.target', '=', aggregate), eb('t.target', 'like', `${aggregate}.%`)]));
    }
    const rows = await query.select(['t.id', 't.kind', 't.target', 't.status', 't.result', 't.error_code', 't.created_at', 't.finished_at', 't.expires_at', 'o.status as delivery', 'o.attempts'])
      .orderBy('t.created_at', 'desc').limit(100).execute();
    return rows.map(taskView);
  }

  private async row(id: string, ctx: Ctx) {
    if (!z.uuid().safeParse(id).success) throw cageError('NOT_FOUND');
    const row = await this.own(ctx).selectAll('t').select(['o.status as delivery', 'o.attempts']).where('t.id', '=', id).executeTakeFirst();
    if (!row) throw cageError('NOT_FOUND');
    return row;
  }

  async get(id: string, ctx: Ctx): Promise<TransferTask> { return taskView(await this.row(id, ctx)); }

  /**
   * 下载前确认终态、实时能力及导出访问指纹；范围/部门树/明文权限变化需要重新生成文件。
   * 必须先完成可靠下载审计，再返回文件内容，防止审计故障时仍泄露既有导出。
   */
  async download(id: string, ctx: Ctx) {
    const row = await this.row(id, ctx);
    if (taskView(row).status !== 'completed') throw cageError('INVALID_TRANSITION', '任务尚未完成或文件已过期');
    const current = await liveContext(this.k, requireUser(ctx), ctx.tenantId);
    requireCap(current, row.kind === 'export' ? `${row.target}.export` : row.target);
    if (row.kind === 'export' && row.access_hash !== await accessHash(this.k, current, row.target)) {
      throw cageError('FORBIDDEN', '数据范围或明文权限已经变化，请重新导出');
    }
    try { await this.k.writeAudit(this.k.app, {
      tenantId: ctx.tenantId, actor: ctx.userId!, actorKind: 'user', source: 'api', kind: 'read',
      capability: row.kind === 'export' ? `${row.target}.export` : row.target, command: 'dataTransfer.download', result: 'ok', diff: { taskId: id },
      requestId: ctx.requestId ?? null, client: ctx.client ?? null,
    }); } catch {
      this.k.log.error({ code: 'CAGE-AUDIT-001', operation: 'dataTransfer.download', task: id, requestId: ctx.requestId }, '下载审计失败，未交付文件');
      throw cageError('INTERNAL', { diagnostic: 'CAGE-AUDIT-001', phase: 'audit', operation: 'dataTransfer.download', retryable: true });
    }
    return { body: row.file_body as string, filename: row.result.filename as string, contentType: row.kind === 'export' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8' };
  }
}

/** 将任务状态与 outbox 投递证据合并；时间已过期时优先标 expired，隐藏已失效的结果元数据。 */
function taskView(row: any): TransferTask {
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  const status = expired ? 'expired' : row.status !== 'queued' ? row.status : row.delivery === 'dead' || row.delivery === 'done' ? 'failed' : row.delivery === 'processing' ? 'processing' : row.attempts > 0 ? 'retrying' : 'queued';
  return {
    id: row.id, kind: row.kind, target: row.target, status, result: expired ? null : row.result,
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null, errorCode: row.error_code ?? (status === 'failed' ? 'INTERNAL' : null),
  };
}

/**
 * 保存点让错误行只回滚自己的写入（含审计和同事务反应）。
 * 整批模式再包一层保存点；出错时撤销全部业务写入，但保留每行的失败报告。
 * 不保存命令返回快照或输入值，避免权限日后收回后从结果文件读到敏感内容。
 */
async function runImport(k: Kernel, tx: Transaction<any>, task: any, ctx: Ctx) {
  const rc = importCommand(k, task.target, ctx);
  const inputs = csvInputs(task.input.csv, rc.cmd.input);
  const results: { row: number; ok: boolean; code?: string; domainCode?: string; fields?: string[] }[] = [];
  await sql`savepoint cage_import_batch`.execute(tx);
  for (const [index, input] of inputs.entries()) {
    await sql`savepoint cage_import_row`.execute(tx);
    try {
      await k.executeIn(tx, rc.cmd, input, ctx);
      results.push({ row: index + 2, ok: true });
    } catch (err) {
      await sql`rollback to savepoint cage_import_row`.execute(tx);
      const error = toCageError(err);
      // 程序错误、连接故障和死锁属于任务失败，交给 outbox 重试，不能伪装成坏数据行。
      if (error.code === 'INTERNAL' || ['40001', '40P01'].includes((err as any)?.code)) throw err;
      // 只报告出错的输入字段名，不保存原始值、数据库错误文本或完整领域错误 detail。
      const fields = error.code === 'INVALID_INPUT' && Array.isArray(error.detail)
        ? error.detail.filter((issue) => typeof issue.path === 'string').map((issue) => issue.path) : [];
      results.push({ row: index + 2, ok: false, code: error.code,
        ...(error.domainCode ? { domainCode: error.domainCode } : {}), ...(fields.length ? { fields } : {}) });
    }
    await sql`release savepoint cage_import_row`.execute(tx);
  }
  if (task.input.atomic && results.some((r) => !r.ok)) {
    await sql`rollback to savepoint cage_import_batch`.execute(tx);
    for (const row of results) if (row.ok) { row.ok = false; row.code = 'ABORTED'; }
  }
  await sql`release savepoint cage_import_batch`.execute(tx);
  const succeeded = results.filter((r) => r.ok).length;
  const result = { rows: results.length, succeeded, failed: results.length - succeeded, atomic: task.input.atomic, filename: `import-${task.id}.json` };
  return { result, body: JSON.stringify({ ...result, results }, null, 2), access: null };
}

/**
 * 消费者锁定任务并重读用户权限；导入/导出结果与 processed_event 在同一事务提交，崩溃可安全重投。
 * 业务拒绝通过保存点记录 failed；内部故障/并发冲突抛给 outbox 重试，不能伪装成已完成任务。
 */
export function transferConsumer(k: Kernel): EventConsumer {
  return {
    name: 'cage:data-transfer', event: EVENT,
    async handle(event, tx) {
      const task = await tx.selectFrom('sys.data_transfer').selectAll().where('id', '=', event.aggregate_id)
        .where('tenant_id', '=', event.tenant_id).forUpdate().executeTakeFirstOrThrow();
      if (task.status !== 'queued') return;
      if (new Date(task.expires_at).getTime() <= Date.now()) {
        await tx.updateTable('sys.data_transfer').set({ status: 'expired', input: null }).where('id', '=', task.id).execute();
        return;
      }
      // 整个任务的业务失败也使用保存点，使 PostgreSQL 错误后仍能可靠记录失败状态。
      await sql`savepoint cage_transfer`.execute(tx);
      try {
        const ctx = await liveContext(k, task.user_id, task.tenant_id, tx);
        ctx.requestId = event.request_id ?? undefined;
        ctx.source = task.kind === 'import' ? 'import' : 'api';
        ctx.stepUpAt = task.input.stepUpAt;
        let output;
        if (task.kind === 'export') {
          const access = await accessHash(k, ctx, task.target, tx);
          const file = await k.read.export(task.target, task.input, ctx, tx);
          output = { result: { rows: file.rows, filename: file.filename }, body: file.body, access };
        } else output = await runImport(k, tx, task, ctx);
        await tx.updateTable('sys.data_transfer').set({ status: 'completed', result: JSON.stringify(output.result), file_body: output.body,
          access_hash: output.access, input: null, finished_at: sql`now()` }).where('id', '=', task.id).execute();
      } catch (err) {
        await sql`rollback to savepoint cage_transfer`.execute(tx);
        const error = toCageError(err);
        if (error.code === 'INTERNAL' || error.code === 'CONFLICT') throw err;
        await tx.updateTable('sys.data_transfer').set({ status: 'failed', error_code: error.code, input: null, finished_at: sql`now()` }).where('id', '=', task.id).execute();
      }
      await sql`release savepoint cage_transfer`.execute(tx);
    },
  };
}

/** 定期清除原文件、结果文件和授权指纹；保留轻量任务记录防止旧幂等键被重复执行。 */
export async function expireTransfers(k: Kernel): Promise<void> {
  await k.app.updateTable('sys.data_transfer').set({ status: 'expired', input: null, file_body: null, result: null, access_hash: null })
    .where('expires_at', '<=', new Date()).where('status', '<>', 'expired').execute();
}
