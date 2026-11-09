// 定时任务调度：多实例只跑一次（PostgreSQL 咨询锁 + 记录上次执行时间）。任务只能读数据和调用声明过的命令。
import { CronExpressionParser } from 'cron-parser';
import { sql } from 'kysely';
import type pg from 'pg';
import { cageError } from '../errors.js';
import type { Kernel } from '../kernel.js';
import { systemCtx } from '../org.js';
import { scopedFind } from '../pipeline/load.js';
import { rowToSnapshot } from '../db/rows.js';
import type { AnyCommand } from '../primitives/command.js';
import type { Job, JobApi } from '../primitives/flow.js';
import { hash32 } from '../util/names.js';

/** 计算给定时间之后的下一周期，不枚举历史遗漏周期；无效 cron 由解析器抛错。 */
export function nextRun(cron: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after }).next().toDate();
}

/**
 * 为一次租户任务构造受限上下文；只能读 j.reads、调用 j.calls 中同一声明对象。
 * 每次 call 独立经过内核事务，整个 job 不是一笔大事务；业务需自行设计多步重试与幂等。
 */
export function jobApi(k: Kernel, j: Job, tenantId: string, now: Date): JobApi {
  const caps = j.calls.map((c) => k.registry.capabilityOf(c));
  const ctx = systemCtx({ kind: 'job', name: j.name, tenantId, capabilities: caps });
  const allowedReads = new Set(j.reads);
  return {
    tenantId,
    now,
    log: (msg, extra) => k.log.info({ job: j.name, ...extra }, msg),
    query: {
      async list(agg, where = {}, opts = {}) {
        if (!allowedReads.has(agg)) throw new Error(`[CAGE-JOB-003] 任务 ${j.name} 读取了未声明的聚合 ${agg.name}`);
        const { createdBefore, createdAfter, updatedBefore, ...eq } = where as Record<string, any>;
        let q = scopedFind(k.app, agg, ctx, eq, { limit: opts.limit ?? 1000 });
        if (createdBefore) q = q.where('t.created_at', '<', new Date(createdBefore));
        if (createdAfter) q = q.where('t.created_at', '>=', new Date(createdAfter));
        if (updatedBefore) q = q.where('t.updated_at', '<', new Date(updatedBefore));
        return (await q.execute()).map((r) => rowToSnapshot(agg, r, false)) as any;
      },
    },
    async call(cmd: AnyCommand, input: unknown) {
      if (!j.calls.includes(cmd)) throw cageError('FORBIDDEN', { message: `[CAGE-JOB-002] 任务 ${j.name} 调用了未声明的命令` });
      return (await k.execute(cmd, input, ctx)) as any;
    },
  };
}

/** 执行一次任务（拿到锁才执行）；返回是否执行了 */
const running = new WeakMap<Kernel, Set<string>>();

/**
 * 同步登记本实例运行标记，再取得专用连接的会话咨询锁；二者分别防同进程重入和跨实例重叠。
 * force 可忽略停用/已跑周期，但仍不能绕过互斥。拿锁后逐租户执行并汇总最后错误。
 * 只有任务 Promise 真正结束才释放锁；返回 true 表示本轮执行过，不表示每个租户业务均成功。
 */
export async function tick(k: Kernel, j: Job, lockConn: pg.Client, scheduledAt: Date, force = false): Promise<boolean> {
  const active = running.get(k) ?? new Set<string>();
  running.set(k, active);
  // 会话 advisory lock 对同一连接可重入，必须先同步登记本进程正在运行的任务。
  // 错过周期默认跳过，不积累一个追赶队列。
  if (active.has(j.name)) {
    k.log.info({ job: j.name, scheduledAt: scheduledAt.toISOString(), reason: 'already-running' }, '跳过重叠的任务周期');
    return false;
  }
  active.add(j.name);
  const lockId = hash32(`cage.job.${j.name}`);
  let locked = false;
  try {
    const r = await lockConn.query('select pg_try_advisory_lock($1) as ok', [lockId]);
    locked = r.rows[0].ok;
    if (!locked) {
      k.log.info({ job: j.name, scheduledAt: scheduledAt.toISOString(), reason: 'other-worker' }, '跳过其他实例持有的任务周期');
      return false;
    }
    await k.app.insertInto('sys.job_state').values({ name: j.name }).onConflict((oc) => oc.column('name').doNothing()).execute();
    const st = await k.app.selectFrom('sys.job_state').selectAll().where('name', '=', j.name).executeTakeFirstOrThrow();
    if (!st.enabled && !force) return false; // 管理员在 /admin 停用了
    if (!force && st.last_run_at && new Date(st.last_run_at) >= scheduledAt) return false; // 这一轮别的实例已经跑过
    const tenants = await k.app.selectFrom('sys.tenant').select('id').execute();
    let error: string | null = null;
    for (const t of tenants) {
      try {
        await j.run(jobApi(k, j, t.id, new Date()));
      } catch (e) {
        error = String((e as Error)?.message ?? e);
        k.log.error({ job: j.name, tenant: t.id, err: error }, '定时任务失败');
      }
    }
    await k.app
      .updateTable('sys.job_state')
      .set({ last_run_at: force ? new Date() : scheduledAt, last_status: error ? 'failed' : 'ok', last_error: error, updated_at: sql`now()` })
      .where('name', '=', j.name)
      .execute();
    return true;
  } finally {
    try {
      if (locked) await lockConn.query('select pg_advisory_unlock($1)', [lockId]); // 任务结束前不能释放跨实例锁
    } finally {
      active.delete(j.name);
    }
  }
}
