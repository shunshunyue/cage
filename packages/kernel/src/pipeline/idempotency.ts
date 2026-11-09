// 幂等：请求头带 Idempotency-Key，内核在事务开头先「抢占」这个键。
// 唯一约束让并发的第二个请求等第一个提交后再判断，最终只执行一次；第一个回滚时第二个会正常执行。
import { sql, type Transaction } from 'kysely';

/**
 * 去重记录与业务数据使用同一个事务，不单独提交“正在处理”状态。
 * key 的主体/命令命名空间由内核上层生成；此模块只处理数据库原子抢占和结果保存。
 */
export const idempotency = {
  /** 未提供 key 时直接放行；冲突时读取首个已提交结果，不再次运行 handler。 */
  async claim(tx: Transaction<any>, key?: string): Promise<{ fresh: true } | { fresh: false; result: unknown }> {
    if (!key) return { fresh: true };
    const row = await tx
      .insertInto('sys.idempotency')
      .values({ key, status: 'running', expires_at: sql`now() + interval '24 hours'` })
      .onConflict((oc) => oc.column('key').doNothing())
      .returning('key')
      .executeTakeFirst();
    if (row) return { fresh: true };
    const prev = await tx.selectFrom('sys.idempotency').select(['result', 'status']).where('key', '=', key).executeTakeFirstOrThrow();
    return { fresh: false, result: prev.result };
  },

  /** 保存可返回给同一调用人的结果；调用方必须在当前事务提交前执行，失败同样回滚业务。 */
  async complete(tx: Transaction<any>, key: string | undefined, result: unknown): Promise<void> {
    if (!key) return;
    await tx
      .updateTable('sys.idempotency')
      .set({ status: 'done', result: JSON.stringify(result) })
      .where('key', '=', key)
      .execute();
  },
};
