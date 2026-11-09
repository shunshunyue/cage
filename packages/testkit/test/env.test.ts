/**
 * 测试环境初始化并发回归：同一 PostgreSQL 集群创建八个独立业务库，但账号角色仍是集群共享资源。
 * 使用 allSettled 收齐成功和失败后断言，验证角色准备互斥且库名互异；finally 关闭全部成功创建的环境。
 * 这里的八路 Promise 是被测数据库竞争场景，与开发助手的智能体并发无关。
 */
// PostgreSQL 角色属于整个集群，不能用“每文件独立库”来隔离角色初始化。
// 同时建立多个测试环境，覆盖 Docker 上出现过的 tuple concurrently updated。
import { expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../src/index.js';
import * as domain from './fixtures/domain.js';

it('同一集群并行创建八个测试库，角色初始化互斥且业务库彼此独立', async () => {
  const environments: TestEnv[] = [];
  try {
    // 等全部初始化结束后再断言，确保失败时也能关闭已经成功创建的环境。
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async () => {
        const env = await createTestEnv({ domain });
        environments.push(env);
        const [row] = await env.query('select current_database() as name');
        return row.name;
      }),
    );
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const names = results.map((result) => (result.status === 'fulfilled' ? result.value : null));
    expect(new Set(names).size).toBe(8);
  } finally {
    await Promise.all(environments.map((env) => env.close()));
  }
});
