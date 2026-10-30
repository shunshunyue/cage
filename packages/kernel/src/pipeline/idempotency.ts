// 幂等：请求头带 Idempotency-Key，内核在事务开头先「抢占」这个键。
// 唯一约束让并发的第二个请求等第一个提交后再判断，最终只执行一次；第一个回滚时第二个会正常执行。
import { sql, type Transaction } from 'kysely';

export const idempotency = {
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

  async complete(tx: Transaction<any>, key: string | undefined, result: unknown): Promise<void> {
    if (!key) return;
    await tx
      .updateTable('sys.idempotency')
      .set({ status: 'done', result: JSON.stringify(result) })
      .where('key', '=', key)
      .execute();
  },
};
