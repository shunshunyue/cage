/**
 * 内嵌 PostgreSQL 进程生命周期回归，实际启动两个临时实例验证停止目标的精确性。
 * 重复停止同一实例应有界完成，另一个实例仍可连接；同时验证原端口已停止接受连接。
 * finally 对两实例兜底清理，连接使用独立短超时；不接触业务项目配置的数据库。
 */
// 同时启动两个独立实例，停止其中一个不得影响另一个；命令整体还须完成 globalSetup 的有界清理。
import pg from 'pg';
import { expect, it } from 'vitest';
import { startEmbeddedPostgres } from '../src/pg.js';

it('内嵌 PostgreSQL 精确停止本次实例，重复停止幂等，另一个实例继续服务', async () => {
  const first = await startEmbeddedPostgres(), second = await startEmbeddedPostgres();
  try {
    const before = Date.now();
    await first.stop();
    await first.stop();
    expect(Date.now() - before).toBeLessThan(15_000);
    const untouched = new pg.Client({ connectionString: second.superUrl, connectionTimeoutMillis: 2_000 });
    try {
      await untouched.connect();
      expect((await untouched.query('select 1 as alive')).rows[0].alive).toBe(1);
    } finally { await untouched.end(); }
    const stopped = new pg.Client({ connectionString: first.superUrl, connectionTimeoutMillis: 1_000 });
    try { await expect(stopped.connect()).rejects.toThrow(); }
    finally { await stopped.end(); }
  } finally { await first.stop(); await second.stop(); }
});
