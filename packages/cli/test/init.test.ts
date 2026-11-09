/**
 * 验证 init 为既有数据库准备账号时的凭据一致性。
 * 隔离 PostgreSQL 中覆盖事务回滚、重复执行、密码保留和实际只读权限，并检查日志不泄漏密码。
 * 测试夹具负责建库；被测命令不得代建业务库，连接、实例与临时文件均由套件释放。
 */
// 使用独立的真实 PostgreSQL 验证账号和凭证的一致性，不接触使用者配置的业务库。
// 重点覆盖失败回滚和重复执行，避免“数据库改了密码，.env 却还是旧值”的部署事故。
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildRegistry } from '@yss123/cage-kernel';
import { createTableSql, runMigrations, schemaModel } from '@yss123/cage-kernel/db';
import { startEmbeddedPostgres, withDb, type PgInstance } from '@yss123/cage-testkit/pg';
import * as domain from '../../testkit/test/fixtures/domain.js';
import { initProject } from '../src/init.js';
import { loadConfig } from '../src/config.js';

const temporary = mkdtempSync(join(tmpdir(), 'cage-init-test-'));
const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
let instance: PgInstance;
let admin: pg.Client;
let adminUrl: string;

beforeAll(async () => {
  instance = await startEmbeddedPostgres();
  admin = new pg.Client({ connectionString: instance.superUrl });
  await admin.connect();
  // 建库是测试夹具的职责。被测 init 只接收这个已经存在的数据库。
  await admin.query('create database cage_init_existing');
  adminUrl = withDb(instance.superUrl, 'cage_init_existing');
}, 30_000);
afterAll(async () => {
  await admin?.end();
  await instance?.stop();
  rmSync(temporary, { recursive: true, force: true });
});

/**
 * 在本套件临时根目录创建最小项目与管理员连接 .env，附加内容用于确认业务配置被保留。
 * 返回正常配置加载结果；不建立数据库，也不修改宿主进程环境。
 */
function project(name: string, connection: string, extra = '') {
  const root = join(temporary, name);
  mkdirSync(root);
  writeFileSync(join(root, 'cage.config.json'), '{}');
  writeFileSync(join(root, '.env'), `# 业务配置与注释需要保留\nCAGE_ADMIN_DATABASE_URL=${connection}\n${extra}`);
  return loadConfig(root);
}
/**
 * 读取隔离实例的 cage_* 角色及密码哈希，按角色名排序以比较初始化前后的精确状态。
 * 仅供测试回滚和不重置密码断言，不把密码哈希输出到生产诊断。
 */
async function roles() {
  return (await admin.query("select rolname, rolpassword from pg_authid where rolname like 'cage_%' order by rolname")).rows;
}

it('授权失败时回滚数据库，保留原 .env 并清理凭证草稿', async () => {
  const readonly = new URL(adminUrl);
  readonly.searchParams.set('options', '-c default_transaction_read_only=on');
  const cfg = project('readonly', readonly.toString());
  const original = readFileSync(join(cfg.root, '.env'), 'utf8');
  await expect(initProject(cfg, {})).rejects.toThrow();
  expect(await roles()).toEqual([]);
  expect(readFileSync(join(cfg.root, '.env'), 'utf8')).toBe(original);
  expect(readdirSync(cfg.root)).toEqual(expect.not.arrayContaining([expect.stringContaining('.tmp')]));
});

it('仅提供管理员连接即可生成账号；迁移可用，重复 init 保留密码和配置', async () => {
  const cfg = project('application', adminUrl, 'PORT=3123\nCAGE_COOKIE_SECRET=REPLACE_WITH_RANDOM_COOKIE_SECRET\n');
  const beforeDatabases = (await admin.query('select datname from pg_database order by datname')).rows;
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) if (name === 'DATABASE_URL' || name.startsWith('CAGE_')) delete childEnv[name];
  const first = spawnSync(process.execPath, [cli, 'init', '--root', cfg.root], { encoding: 'utf8', env: childEnv });
  expect(first.status, first.stderr).toBe(0);
  const original = readFileSync(join(cfg.root, '.env'), 'utf8');
  const values = parseEnv(original);
  expect(values.CAGE_ADMIN_DATABASE_URL).toBeUndefined();
  expect(values.CAGE_COOKIE_SECRET).toMatch(/^[a-f0-9]{64}$/);
  expect(values.PORT).toBe('3123');
  expect(original).toContain('# 业务配置与注释需要保留');
  const passwords = ['APP', 'READ', 'MIGRATE'].map((key) => new URL(values[`CAGE_${key}_DATABASE_URL`]).password);
  expect(passwords.every((password) => /^[a-f0-9]{48}$/.test(password))).toBe(true);
  expect(new Set(passwords).size).toBe(3);
  for (const password of passwords) expect(first.stdout + first.stderr).not.toContain(password);
  expect(first.stdout + first.stderr).not.toContain(adminUrl);
  expect((await admin.query('select datname from pg_database order by datname')).rows).toEqual(beforeDatabases);

  // 用刚生成的迁移账号运行真实迁移，再验证只读账号无法直接访问基表。
  const registry = buildRegistry(domain);
  await runMigrations({
    migrateUrl: values.CAGE_MIGRATE_DATABASE_URL,
    registry,
    migrations: [{ name: '0001_init_test', sql: schemaModel(registry).tables.map(createTableSql).join('\n\n') }],
  });
  const read = new pg.Client({ connectionString: values.CAGE_READ_DATABASE_URL });
  await read.connect();
  try {
    await expect(read.query('select * from core.purchase_order')).rejects.toMatchObject({ code: '42501' });
    expect((await read.query('select * from safe.purchase_order')).rowCount).toBe(0);
  } finally { await read.end(); }
  const beforeRoles = await roles();
  const repeat = spawnSync(process.execPath, [cli, 'init', '--root', cfg.root], { encoding: 'utf8', env: childEnv });
  expect(repeat.status, repeat.stderr).toBe(0);
  expect(readFileSync(join(cfg.root, '.env'), 'utf8')).toBe(original);
  expect(await roles()).toEqual(beforeRoles);

  // 管理员再次提供连接时只补授权，依旧不能修改原账号的密码。
  expect((await initProject(cfg, { CAGE_ADMIN_DATABASE_URL: adminUrl })).status).toBe('reused');
  expect(await roles()).toEqual(beforeRoles);
});

it('其他项目已有集群角色时拒绝猜测或重置密码，错误凭证也不会覆盖配置', async () => {
  const cfg = project('another-application', adminUrl);
  const original = readFileSync(join(cfg.root, '.env'), 'utf8');
  const before = await roles();
  await expect(initProject(cfg, {})).rejects.toThrow('CAGE-INIT-002');
  expect(await roles()).toEqual(before);
  expect(readFileSync(join(cfg.root, '.env'), 'utf8')).toBe(original);

  const saved = parseEnv(readFileSync(join(temporary, 'application', '.env'), 'utf8'));
  const wrong = new URL(saved.CAGE_APP_DATABASE_URL);
  wrong.password = 'deliberately-wrong';
  await expect(initProject(cfg, { ...saved, CAGE_APP_DATABASE_URL: wrong.toString() })).rejects.toThrow('无法使用当前配置登录');
  expect(await roles()).toEqual(before);
  expect(readFileSync(join(cfg.root, '.env'), 'utf8')).toBe(original);
});

it('数据库不存在时给出错误，不建库、不改 .env，也不创建 Cookie 密钥', async () => {
  const cfg = project('missing-database', withDb(adminUrl, 'must_not_create'));
  const original = readFileSync(join(cfg.root, '.env'), 'utf8');
  await expect(initProject(cfg, {})).rejects.toThrow('不存在');
  expect((await admin.query("select 1 from pg_database where datname = 'must_not_create'")).rowCount).toBe(0);
  expect(readFileSync(join(cfg.root, '.env'), 'utf8')).toBe(original);
});
