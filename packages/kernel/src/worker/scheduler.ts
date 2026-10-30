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

export function nextRun(cron: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after }).next().toDate();
}

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
export async function tick(k: Kernel, j: Job, lockConn: pg.Client, scheduledAt: Date, force = false): Promise<boolean> {
  const lockId = hash32(`cage.job.${j.name}`);
  const r = await lockConn.query('select pg_try_advisory_lock($1) as ok', [lockId]);
  if (!r.rows[0].ok) return false; // 别的实例在跑：本实例跳过
  try {
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
    await lockConn.query('select pg_advisory_unlock($1)', [lockId]); // 加锁和解锁必须在同一个连接上
  }
}
