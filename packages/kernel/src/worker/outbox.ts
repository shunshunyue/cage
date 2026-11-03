// outbox 投递器：多个 worker 实例同时领取，靠 FOR UPDATE SKIP LOCKED 避免重复领取；同一聚合的事件严格按顺序处理。
import { sql, type Transaction } from 'kysely';
import { isCageError } from '../errors.js';
import type { Kernel } from '../kernel.js';
import { withCarrier } from '../telemetry.js';

export interface OutboxRow {
  id: number;
  tenant_id: string;
  event: string;
  aggregate: string;
  aggregate_id: string;
  payload: Record<string, any>;
  actor: { kind?: string; id?: string; userId?: string | null; onBehalfOf?: string | null } | null;
  trace: Record<string, string> | null;
  request_id: string | null;
  status: string;
  attempts: number;
}

/** 事件消费者：反应、出站映射、审批启动都实现这个接口。登记去重和业务写入在同一个事务里提交。 */
export interface EventConsumer {
  /** 唯一名，用于 (事件 id, 消费者) 去重 */
  name: string;
  event: string;
  /** 外部 IO 在没有数据库事务占用连接时执行；恢复凭证由实现持久化。 */
  prepare?(row: OutboxRow, kernel: Kernel, options: { signal?: AbortSignal }): Promise<unknown>;
  handle(row: OutboxRow, tx: Transaction<any>, kernel: Kernel, prepared?: unknown): Promise<void>;
}

const manifests = new WeakMap<Kernel, Map<string, string[]>>();

/** 运行期清单是启动验证的结果；投递时不能因为调用方漏传了关键消费者而静默完成。 */
export function registerConsumerManifest(k: Kernel, consumers: EventConsumer[]): void {
  const names = new Set<string>();
  const events = new Map<string, string[]>(k.registry.events.map((e) => [e.name, []]));
  for (const c of consumers) {
    if (names.has(c.name)) throw new Error(`[CAGE-WORKER-002] 消费者名称重复：${c.name}`);
    names.add(c.name);
    events.set(c.event, [...(events.get(c.event) ?? []), c.name]);
  }
  manifests.set(k, events);
}

export const MAX_ATTEMPTS = 10;

/** 指数退避：1 秒、2 秒、4 秒……最多 1 小时 */
export function backoffMs(attempts: number): number {
  return Math.min(3600_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

export async function claimBatch(k: Kernel, limit: number): Promise<OutboxRow[]> {
  return k.app.transaction().execute(async (tx) => {
    const { rows } = await sql<OutboxRow>`
      select o.* from sys.outbox o
      where o.status = 'pending'
        and o.next_at <= now()
        and not exists (
          select 1 from sys.outbox p
          where p.aggregate_id = o.aggregate_id
            and p.id < o.id and p.status <> 'done')
      order by o.id
      limit ${limit}
      for update skip locked`.execute(tx);
    if (rows.length > 0) {
      await tx
        .updateTable('sys.outbox')
        .set({ status: 'processing', locked_at: sql`now()` })
        .where('id', 'in', rows.map((r) => r.id))
        .execute();
    }
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });
}

/** 业务错误、状态不对、越权这类错误重试也不会成功，直接进死信 */
function isPermanent(err: unknown): boolean {
  const e = err as any;
  if (e?.permanent === true) return true;
  if (e?.retryable === true) return false;
  if (isCageError(err)) return !['CONFLICT', 'INTERNAL', 'RATE_LIMITED'].includes(e.code);
  // 带错误码的框架错误（声明不一致、载荷不符合声明等）重试也不会好
  return /\[CAGE-/.test(String(e?.message ?? ''));
}

export async function deliver(k: Kernel, row: OutboxRow, consumers: EventConsumer[], maxAttempts = MAX_ATTEMPTS, options: { signal?: AbortSignal } = {}): Promise<'done' | 'retry' | 'dead'> {
  const mine = consumers.filter((c) => c.event === row.event);
  try {
    const manifest = manifests.get(k);
    const required = manifest?.get(row.event);
    const missing = required?.filter((name) => !mine.some((c) => c.name === name)) ?? [];
    if (missing.length || (mine.length === 0 && !(manifest?.has(row.event) ?? k.registry.events.some((e) => e.name === row.event)))) {
      throw new Error(`[CAGE-WORKER-002] 事件 ${row.event} 缺少必要消费者或不属于当前注册版本：${missing.join(', ') || 'unknown-event'}`);
    }
    await withCarrier(row.trace, async () => {
      for (const c of mine) {
        options.signal?.throwIfAborted();
        const already = await k.app.selectFrom('sys.processed_event').select('event_id').where('event_id', '=', row.id).where('consumer', '=', c.name).executeTakeFirst();
        if (already) continue;
        // 出站执行不在下方事务内等待网络，也不会持有连接再向同一个池取第二条连接。
        const prepared = c.prepare ? await c.prepare(row, k, options) : undefined;
        await k.app.transaction().execute(async (tx) => {
          const first = await tx
            .insertInto('sys.processed_event')
            .values({ event_id: row.id, consumer: c.name })
            .onConflict((oc) => oc.columns(['event_id', 'consumer']).doNothing())
            .returning('event_id')
            .executeTakeFirst();
          if (!first) return; // 处理过了：直接跳过，保证幂等
          await c.handle(row, tx, k, prepared);
        });
      }
    });
    await k.app.updateTable('sys.outbox').set({ status: 'done', done_at: sql`now()`, locked_at: null }).where('id', '=', row.id).execute();
    return 'done';
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = isCageError(err) ? JSON.stringify((err as any).toJSON()) : String((err as Error)?.message ?? err);
    if (attempts >= maxAttempts || isPermanent(err)) {
      await k.app.transaction().execute(async (tx) => {
        await tx
          .insertInto('sys.dead_letter')
          .values({ outbox_id: row.id, tenant_id: row.tenant_id, event: row.event, aggregate_id: row.aggregate_id, payload: JSON.stringify(row.payload), error: message, attempts })
          .execute();
        await tx.updateTable('sys.outbox').set({ status: 'dead', attempts, last_error: message, locked_at: null }).where('id', '=', row.id).execute();
      });
      k.log.error({ outboxId: row.id, event: row.event, err: message }, '事件进入死信');
      return 'dead';
    }
    await k.app
      .updateTable('sys.outbox')
      .set({ status: 'pending', attempts, last_error: message, locked_at: null, next_at: new Date(Date.now() + backoffMs(attempts)) })
      .where('id', '=', row.id)
      .execute();
    k.log.warn({ outboxId: row.id, event: row.event, attempts, err: message }, '事件投递失败，稍后重试');
    return 'retry';
  }
}

/** 清扫：worker 崩溃后卡在「处理中」超过 5 分钟的事件重置为待投递 */
export async function sweepStale(k: Kernel, olderThanMs = 5 * 60_000): Promise<number> {
  const r = await k.app
    .updateTable('sys.outbox')
    .set({ status: 'pending', locked_at: null })
    .where('status', '=', 'processing')
    .where('locked_at', '<', new Date(Date.now() - olderThanMs))
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/** 人工重放死信：仍然走内核流水线 */
export async function replayDeadLetter(k: Kernel, deadLetterId: number, handledBy: string): Promise<void> {
  await k.app.transaction().execute(async (tx) => {
    const d = await tx.selectFrom('sys.dead_letter').selectAll().where('id', '=', deadLetterId).where('handled_at', 'is', null).forUpdate().executeTakeFirst();
    if (!d) throw new Error('[CAGE-DLQ-001] 死信不存在或已处理');
    await tx.updateTable('sys.outbox').set({ status: 'pending', attempts: 0, next_at: sql`now()`, last_error: null }).where('id', '=', d.outbox_id).execute();
    await tx.updateTable('sys.dead_letter').set({ handled_by: handledBy, handled_at: sql`now()`, resolution: 'replayed' }).where('id', '=', deadLetterId).execute();
    await sql`select pg_notify('cage_outbox', '')`.execute(tx);
  });
}

/** 人工丢弃死信：标记完成，解除对同一聚合后续事件的阻塞 */
export async function discardDeadLetter(k: Kernel, deadLetterId: number, handledBy: string): Promise<void> {
  await k.app.transaction().execute(async (tx) => {
    const d = await tx.selectFrom('sys.dead_letter').selectAll().where('id', '=', deadLetterId).where('handled_at', 'is', null).forUpdate().executeTakeFirst();
    if (!d) throw new Error('[CAGE-DLQ-001] 死信不存在或已处理');
    await tx.updateTable('sys.outbox').set({ status: 'done', done_at: sql`now()` }).where('id', '=', d.outbox_id).execute();
    await tx.updateTable('sys.dead_letter').set({ handled_by: handledBy, handled_at: sql`now()`, resolution: 'discarded' }).where('id', '=', deadLetterId).execute();
    await sql`select pg_notify('cage_outbox', '')`.execute(tx);
  });
}
