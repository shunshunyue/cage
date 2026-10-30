import pg from 'pg';
import { bootstrapSql, q, readMigrations, runMigrations } from '@yss123/cage-kernel/db';
import { urlsFromEnv } from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';
import { loadRegistry } from './load.js';

export async function initializeDatabase(
  superUrl: string,
  databaseUrl: string,
  passwords: { app: string; read: string; migrate: string },
) {
  const target = new URL(databaseUrl);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name))
    throw new Error('[CAGE-MIG-003] 数据库名只允许小写字母、数字和下划线，以字母开头');
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  try {
    if (!(await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount)
      await admin.query(`create database ${q(name)}`);
  } finally {
    await admin.end();
  }
  const url = new URL(superUrl);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    // 角色是集群级别；重复初始化不能静默轮换其他项目的密码。
    if (
      (await db.query("select 1 from pg_roles where rolname in ('cage_app','cage_read','cage_migrate')"))
        .rowCount
    ) {
      throw new Error(
        '[CAGE-MIG-004] 集群已有 cage 账号，拒绝覆盖密码；请复用已初始化的库或使用独立 PostgreSQL 集群',
      );
    }
    await db.query('begin');
    await db.query(bootstrapSql(passwords, name));
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');
    throw e;
  } finally {
    await db.end();
  }
}

export async function migrate(cfg: CageConfig, init = false, env = process.env) {
  const urls = urlsFromEnv(env);
  if (!urls.migrate) throw new Error('[CAGE-ENV-001] 设置 CAGE_MIGRATE_DATABASE_URL');
  if (init) {
    if (!env.CAGE_SUPER_DATABASE_URL) throw new Error('[CAGE-ENV-001] 初始化需要 CAGE_SUPER_DATABASE_URL');
    const password = (url: string) => {
      const pw = decodeURIComponent(new URL(url).password);
      if (!pw) throw new Error('[CAGE-ENV-001] 初始化连接串必须包含密码');
      return pw;
    };
    await initializeDatabase(env.CAGE_SUPER_DATABASE_URL, urls.migrate, {
      app: password(urls.app),
      read: password(urls.read),
      migrate: password(urls.migrate),
    });
  }
  const { registry } = await loadRegistry(abs(cfg, cfg.domain));
  return runMigrations({
    migrateUrl: urls.migrate,
    registry,
    migrations: readMigrations(abs(cfg, cfg.migrations)),
    log: console.log,
  });
}
