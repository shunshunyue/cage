// 真实 CLI、ACL 和隔离 PostgreSQL：凭据交付必须先于组织初始化提交。
// 测试库迁移完整业务模型，以证明 bootstrap 不会顺带授予业务权限。
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { bootstrapOrg } from '@yss123/cage-admin';
import * as organization from '@yss123/cage-admin/domain';
import { buildRegistry, createKernel, silentLogger } from '@yss123/cage-kernel';
import { bootstrapSql, createTableSql, runMigrations, schemaModel } from '@yss123/cage-kernel/db';
import { startEmbeddedPostgres, withDb, type PgInstance } from '@yss123/cage-testkit/pg';
import { verifyPassword } from '../../http/src/auth.js';
import * as domain from '../../testkit/test/fixtures/domain.js';
import { bootstrapOrganization, protectCredentialFile } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

const aclFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    if (aclFailure.enabled && args[0] === 'icacls') throw new Error('Controlled ACL denial');
    return actual.execFileSync(...args);
  } };
});

const temporary = mkdtempSync(join(tmpdir(), 'cage-bootstrap-test-'));
const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
const clients: pg.Client[] = [];
let instance: PgInstance;
let successful: Awaited<ReturnType<typeof database>>;
let rejected: Awaited<ReturnType<typeof database>>;

async function database(name: string) {
  const manager = new pg.Client({ connectionString: instance.superUrl });
  await manager.connect();
  try { await manager.query(`create database ${name}`); }
  finally { await manager.end(); }
  const client = new pg.Client({ connectionString: withDb(instance.superUrl, name) });
  await client.connect();
  clients.push(client);
  const passwords = { app: 'bootstrap_test_app_pw', read: 'bootstrap_test_read_pw', migrate: 'bootstrap_test_migrate_pw' };
  await client.query(bootstrapSql(passwords, name));
  const urls = {
    app: withDb(instance.superUrl, name, { name: 'cage_app', password: passwords.app }),
    read: withDb(instance.superUrl, name, { name: 'cage_read', password: passwords.read }),
    migrate: withDb(instance.superUrl, name, { name: 'cage_migrate', password: passwords.migrate }),
  };
  const registry = buildRegistry(domain);
  await runMigrations({ migrateUrl: urls.migrate, registry, migrations: [{ name: '0001_bootstrap_test', sql: schemaModel(registry).tables.map(createTableSql).join('\n\n') }] });
  return { client, urls };
}

beforeAll(async () => {
  instance = await startEmbeddedPostgres();
  successful = await database('cage_bootstrap_success');
  rejected = await database('cage_bootstrap_rejected');
  writeFileSync(join(temporary, 'cage.config.json'), '{}');
}, 60_000);

afterAll(async () => {
  for (const client of clients) await client.end();
  await instance?.stop();
  // temporary is the exact directory returned by mkdtempSync for this suite.
  rmSync(temporary, { recursive: true, force: true });
}, 30_000);

function childEnv(db: typeof successful): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name === 'DATABASE_URL' || name.startsWith('CAGE_')) delete env[name];
  return { ...env, CAGE_APP_DATABASE_URL: db.urls.app, CAGE_READ_DATABASE_URL: db.urls.read, CAGE_MIGRATE_DATABASE_URL: db.urls.migrate };
}

function bootstrap(db: typeof successful, file: string, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, 'bootstrap', '--root', temporary, '--credentials-file', file], {
    encoding: 'utf8', env: { ...childEnv(db), ...overrides }, timeout: 20_000, windowsHide: true,
  });
}

async function snapshot(db: typeof successful) {
  const state: Record<string, unknown> = {};
  for (const table of ['sys.user', 'sys.role', 'sys.dept', 'sys.audit_log', 'sys.outbox'])
    state[table] = (await db.client.query(`select * from ${table} order by id`)).rows;
  return state;
}

function assertRestricted(file: string) {
  if (process.platform !== 'win32') {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return;
  }
  // Inspect actual SIDs/rights, so localized icacls output cannot make this assertion pass accidentally.
  const script = `$ErrorActionPreference = 'Stop'
    $acl = [System.IO.File]::GetAccessControl($env:CAGE_TEST_CREDENTIAL_FILE)
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; rights = [int]$_.FileSystemRights; type = [int]$_.AccessControlType }
    })
    @{ protected = $acl.AreAccessRulesProtected; current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules = $rules } | ConvertTo-Json -Depth 4 -Compress`;
  const acl = JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, CAGE_TEST_CREDENTIAL_FILE: file }, windowsHide: true, stdio: 'pipe',
  }).trim());
  expect(acl.protected).toBe(true);
  expect(acl.rules).toHaveLength(1);
  expect(acl.rules[0]).toMatchObject({ sid: acl.current, inherited: false, type: 0 });
  expect(acl.rules[0].rights & 0x1f01ff).toBe(0x1f01ff); // FileSystemRights.FullControl
}

it('凭据仅交付新受限文件，只授组织能力，重复执行不重置账号或授权', async () => {
  expect((await successful.client.query("select to_regclass('core.purchase_order') as name")).rows[0].name).toBe('core.purchase_order');
  const file = join(temporary, 'initial-credentials.json');
  // Environment usernames are not the process security identity (common with service/sandbox accounts).
  const first = bootstrap(successful, file, { USERNAME: 'cage_bootstrap_not_process_identity', USERDOMAIN: 'nonexistent-bootstrap-domain' });
  expect(first.status, first.stderr).toBe(0);
  const credentials = JSON.parse(readFileSync(file, 'utf8'));
  expect(credentials.username).toBe('admin');
  expect(typeof credentials.password === 'string' && /^[A-Za-z0-9_-]{32}$/.test(credentials.password)).toBe(true);
  expect((first.stdout + first.stderr).includes(credentials.password)).toBe(false);
  expect((first.stdout + first.stderr).includes(successful.urls.app)).toBe(false);
  assertRestricted(file);

  const users = (await successful.client.query('select username, password_hash, role_ids from sys.user')).rows;
  expect(users).toHaveLength(1);
  expect(await verifyPassword(credentials.password, users[0].password_hash)).toBe(true);
  const roles = (await successful.client.query('select id, capabilities from sys.role')).rows;
  expect(roles).toHaveLength(1);
  expect(users[0].role_ids).toEqual([roles[0].id]);
  const organizationCaps = buildRegistry(organization).capabilityCatalog().map(entry => entry.capability).sort();
  const granted = roles[0].capabilities.map((entry: { capability: string }) => entry.capability).sort();
  expect(granted).toEqual(organizationCaps);
  const businessCaps = buildRegistry(domain).capabilityCatalog().map(entry => entry.capability).filter(capability => !organizationCaps.includes(capability));
  expect(businessCaps.length).toBeGreaterThan(0);
  expect(businessCaps.some(capability => granted.includes(capability))).toBe(false);

  const before = await snapshot(successful);
  const repeatFile = join(temporary, 'repeat-result.json');
  const repeat = bootstrap(successful, repeatFile);
  expect(repeat.status, repeat.stderr).toBe(0);
  expect(await snapshot(successful)).toEqual(before);
  expect(JSON.parse(readFileSync(repeatFile, 'utf8'))).toMatchObject({ created: false });
  expect(JSON.parse(readFileSync(repeatFile, 'utf8')).password).toBeUndefined();
  expect((repeat.stdout + repeat.stderr).includes(credentials.password)).toBe(false);
  assertRestricted(repeatFile);
}, 30_000);

it('拒绝已有凭据文件，保留原文件且不修改数据库', async () => {
  const file = join(temporary, 'existing-credentials.json');
  const original = 'existing credential must remain unchanged\n';
  writeFileSync(file, original);
  const before = await snapshot(rejected);
  expect(() => protectCredentialFile(file)).toThrow('CAGE-INIT-005');
  const result = bootstrap(rejected, file);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('CAGE-INIT-005');
  expect(result.stderr.includes(file)).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(await snapshot(rejected)).toEqual(before);
  const missingParent = join(temporary, 'absent-directory', 'credentials.json');
  const absent = bootstrap(rejected, missingParent);
  expect(absent.status).toBe(1);
  expect(absent.stderr).toContain('CAGE-INIT-005');
  expect(absent.stderr.includes(missingParent)).toBe(false);
  expect(await snapshot(rejected)).toEqual(before);
});

it.runIf(process.platform === 'win32')('ACL 授权命令失败时不写入凭据、不修改数据库', async () => {
  const file = join(temporary, 'acl-rejected-credentials.json');
  const before = await snapshot(rejected);
  // The successful path uses real icacls; inject only its failure without adding a production test option.
  for (const [name, value] of Object.entries(childEnv(rejected)))
    if (name.startsWith('CAGE_')) vi.stubEnv(name, value);
  aclFailure.enabled = true;
  try { await expect(bootstrapOrganization(loadConfig(temporary), file)).rejects.toThrow('CAGE-INIT-005'); }
  finally { aclFailure.enabled = false; vi.unstubAllEnvs(); }
  expect(readFileSync(file, 'utf8')).toBe('');
  expect(await snapshot(rejected)).toEqual(before);
});

it('凭据交付写入失败回滚整个组织，随后可用新文件重新初始化', async () => {
  const before = await snapshot(rejected);
  const kernel = createKernel({ domain: organization, urls: rejected.urls, logger: silentLogger });
  let attempted = false;
  try {
    await expect(bootstrapOrg(kernel, {
      deliverCredentials: credentials => {
        attempted = true;
        // A real file-system failure at delivery, after user/role/password writes inside the transaction.
        writeFileSync(join(temporary, 'missing-parent', 'credentials.json'), JSON.stringify(credentials));
      },
    })).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await kernel.close(); }
  expect(attempted).toBe(true);
  expect(await snapshot(rejected)).toEqual(before);
  for (const table of ['sys.user', 'sys.role', 'sys.dept'])
    expect((await rejected.client.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);

  const file = join(temporary, 'retry-credentials.json');
  const result = bootstrap(rejected, file);
  expect(result.status, result.stderr).toBe(0);
  const credentials = JSON.parse(readFileSync(file, 'utf8'));
  expect((result.stdout + result.stderr).includes(credentials.password)).toBe(false);
  const users = (await rejected.client.query('select password_hash from sys.user')).rows;
  expect(users).toHaveLength(1);
  expect(await verifyPassword(credentials.password, users[0].password_hash)).toBe(true);
  assertRestricted(file);
}, 30_000);
