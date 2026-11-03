// 首次接入已有 PostgreSQL：管理员只提供一次连接，框架负责账号、授权和本地凭证。
// 建库、容器生命周期和业务表迁移仍由各自流程负责，启动应用不会隐式调用本模块。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { bootstrapSql } from '@yss123/cage-kernel/db';
import { abs, type CageConfig } from './config.js';
import { databaseConnectionError } from './migrate.js';

const accounts = { APP: 'cage_app', READ: 'cage_read', MIGRATE: 'cage_migrate' } as const;
type Account = keyof typeof accounts;
type Connections = Record<Account, string>;
const configured = (value: string | undefined): value is string => !!value && !value.includes('REPLACE_WITH_');

/** 校验保存的账号能真正登录；重复 init 不以“文件存在”代替初始化成功。 */
async function verifyConnections(urls: Connections): Promise<void> {
  const target = new URL(urls.APP);
  for (const key of Object.keys(accounts) as Account[]) {
    const url = new URL(urls[key]);
    if (url.username !== accounts[key] || url.host !== target.host || url.pathname !== target.pathname) {
      throw new Error('[CAGE-INIT-003] APP / READ / MIGRATE 需使用各自的 cage 账号，指向同一个数据库；请检查 .env');
    }
    const client = new pg.Client({ connectionString: urls[key], connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
    } catch (error) {
      throw databaseConnectionError(error, urls[key]);
    } finally {
      await client.end();
    }
  }
}

/** 只更新框架生成的条目，保留业务自定义项和原注释；管理员密码不留在成功后的文件里。 */
function completedEnv(source: string, urls: Connections): string {
  let content = source.replace(/^[ \t]*(?:export\s+)?CAGE_ADMIN_DATABASE_URL\s*=.*(?:\r?\n|$)/gm, '# CAGE_ADMIN_DATABASE_URL=\n');
  const put = (key: string, value: string, comment: string) => {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^(?:# ?)?${key}\\s*=.*$`, 'gm');
    if (pattern.test(content)) content = content.replace(pattern, line);
    else content = `${content.trimEnd()}\n\n# ${comment}\n${line}\n`;
  };
  for (const key of Object.keys(accounts) as Account[]) {
    put(`CAGE_${key}_DATABASE_URL`, urls[key], {
      APP: '业务写入连接：API 和 worker 使用，与其他连接指向同一个数据库。',
      READ: '安全查询连接：只能通过安全视图读取，与写入账号隔离。',
      MIGRATE: '表结构迁移连接：仅 pnpm migrate 使用，运行应用时不需要此账号。',
    }[key]);
  }
  if (!configured(parseEnv(content).CAGE_COOKIE_SECRET)) {
    put('CAGE_COOKIE_SECRET', randomBytes(32).toString('hex'), '会话 Cookie 签名密钥，由 cage init 生成；同一应用实例间保持一致。');
  }
  return content.trimEnd() + '\n';
}

export interface InitResult {
  status: 'created' | 'reused';
  envFile: string;
}

export async function initProject(cfg: CageConfig, env: NodeJS.ProcessEnv = process.env): Promise<InitResult> {
  const envFile = abs(cfg, '.env');
  const source = existsSync(envFile) ? readFileSync(envFile, 'utf8')
    : existsSync(abs(cfg, '.env.example')) ? readFileSync(abs(cfg, '.env.example'), 'utf8') : '';
  const values = { ...parseEnv(source), ...env };
  const saved = Object.fromEntries((Object.keys(accounts) as Account[])
    .map((key) => [key, values[`CAGE_${key}_DATABASE_URL`]])) as Connections;
  const hasSaved = Object.values(saved).every(configured);
  const adminUrl = values.CAGE_ADMIN_DATABASE_URL;

  // 成功后已移除管理员连接，日常重复执行只验证已有账号，不再索取管理员密码。
  if (!configured(adminUrl)) {
    if (!hasSaved) throw new Error('[CAGE-ENV-001] 首次初始化请在项目 .env 填写 CAGE_ADMIN_DATABASE_URL，连接已有数据库后运行 pnpm exec cage init');
    await verifyConnections(saved);
    return { status: 'reused', envFile };
  }
  const target = new URL(adminUrl);
  if (!target.pathname || target.pathname === '/') {
    throw new Error('[CAGE-INIT-001] 管理员连接必须指定已经存在的数据库名，例如 postgresql://postgres:密码@localhost:5432/business_db');
  }
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000, application_name: 'cage-init' });
  let staged: string | undefined;
  let committed = false;
  try {
    await admin.connect();
    await admin.query('begin');
    // 同一数据库的首次初始化串行，避免两个终端同时创建角色。
    await admin.query('select pg_advisory_xact_lock(727275)');
    const existing = await admin.query("select rolname from pg_roles where rolname in ('cage_app', 'cage_read', 'cage_migrate', 'cage_view_owner')");
    const reuse = existing.rowCount !== 0;
    if (reuse) {
      if (existing.rowCount !== 4 || !hasSaved) {
        throw new Error('[CAGE-INIT-002] PostgreSQL 集群已有 Cage 账号；请在 .env 提供已有的 APP / READ / MIGRATE 连接后重试。初始化不会重置这些账号的密码');
      }
      if (new URL(saved.APP).host !== target.host || new URL(saved.APP).pathname !== target.pathname) {
        throw new Error('[CAGE-INIT-003] 已有账号连接与管理员连接必须指向同一个数据库；请检查 .env');
      }
      await verifyConnections(saved);
    }
    const passwords = { app: randomBytes(24).toString('hex'), read: randomBytes(24).toString('hex'), migrate: randomBytes(24).toString('hex') };
    const urls = reuse ? saved : Object.fromEntries((Object.keys(accounts) as Account[]).map((key) => {
      const url = new URL(adminUrl);
      url.username = accounts[key];
      url.password = passwords[key.toLowerCase() as keyof typeof passwords];
      return [key, url.toString()];
    })) as Connections;

    // 先把凭证完整写到同目录临时文件，确认本地可写，再修改数据库权限。
    // 数据库失败时删除草稿并回滚；提交后若替换失败，保留草稿供恢复，避免丢失随机密码。
    const draft = `${envFile}.cage-init-${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(draft, completedEnv(source, urls), { mode: 0o600, flag: 'wx' });
    staged = draft;
    const { rows: [database] } = await admin.query('select current_database() as name');
    // bootstrapSql 对空密码不发 ALTER ROLE；复用账号时仅补目标库授权，绝不轮换密码。
    await admin.query(bootstrapSql(reuse ? { app: '', read: '', migrate: '' } : passwords, database.name));
    await admin.query('commit');
    committed = true;
    try {
      renameSync(staged, envFile);
    } catch {
      throw new Error(`[CAGE-INIT-004] 账号权限已准备，但无法替换 .env；凭证保存在 ${staged}，请将它恢复为项目 .env 后继续`);
    }
    staged = undefined;
    return { status: reuse ? 'reused' : 'created', envFile };
  } catch (error) {
    if (!committed) await admin.query('rollback').catch(() => {});
    throw databaseConnectionError(error, adminUrl);
  } finally {
    await admin.end();
    if (staged && !committed) unlinkSync(staged);
  }
}
