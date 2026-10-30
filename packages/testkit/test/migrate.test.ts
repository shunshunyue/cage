// 在真实数据库上验证迁移不可变性，防止 checksum 仅写入却没有参与校验。
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTableSql, schemaModel, runMigrations } from '@yss123/cage-kernel/db';
import { createTestEnv, type TestEnv } from '../src/index.js';
import * as domain from './fixtures/domain.js';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv({ domain }); });
afterAll(() => env?.close());

it('重复执行同一迁移不会重新建表', async () => {
  const migration = { name: '0001_test_schema', sql: schemaModel(env.kernel.registry).tables.map(createTableSql).join('\n\n') };
  const result = await runMigrations({ migrateUrl: env.urls.migrate, registry: env.kernel.registry, migrations: [migration] });
  expect(result.applied).toEqual([]);
});

it('历史迁移被改写时，在执行新迁移之前拒绝', async () => {
  await expect(runMigrations({ migrateUrl: env.urls.migrate, registry: env.kernel.registry, migrations: [
    { name: '0001_test_schema', sql: '-- 被改写的历史迁移' },
    { name: '0002_should_not_apply', sql: 'create table core.must_not_exist (id integer)' },
  ] })).rejects.toThrow('CAGE-MIG-005');
  const rows = await env.query("select to_regclass('core.must_not_exist') as name");
  expect(rows[0].name).toBeNull();
});
