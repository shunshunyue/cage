// 迁移只更新已有数据库的表、视图；账号权限由 cage init 准备，不在迁移中隐式修改。
import { readMigrations, runMigrations } from '@yss123/cage-kernel/db';
import { urlsFromEnv } from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';
import { loadRegistry } from './load.js';

/** 给首次使用者可执行的步骤，只展示地址和库名，绝不输出连接串中的密码。 */
export function databaseConnectionError(error: unknown, databaseUrl: string): Error {
  const code = (error as { code?: string })?.code;
  const target = new URL(databaseUrl);
  const address = `${target.hostname}:${target.port || '5432'}${target.pathname}`;
  const messages: Record<string, string> = {
    '28P01': `无法使用当前配置登录数据库 ${address}。请检查项目根目录 .env 中的地址、端口、账号和密码是否属于同一个数据库；框架不会自动修改数据库账号。`,
    '3D000': `数据库 ${address} 不存在。请在项目根目录 .env 中填写已经存在的 PostgreSQL 数据库；框架不会创建数据库。`,
    ECONNREFUSED: `无法连接数据库 ${address}。请检查数据库服务是否运行，并核对项目根目录 .env 中的地址和端口。`,
  };
  return code && messages[code] ? new Error(messages[code], { cause: error }) : error instanceof Error ? error : new Error(String(error));
}

export async function migrate(cfg: CageConfig, env = process.env) {
  const urls = urlsFromEnv(env);
  if (!urls.migrate) throw new Error('[CAGE-ENV-001] 设置 CAGE_MIGRATE_DATABASE_URL');
  const { registry } = await loadRegistry(abs(cfg, cfg.domain));
  return runMigrations({
    migrateUrl: urls.migrate,
    registry,
    migrations: readMigrations(abs(cfg, cfg.migrations)),
    log: console.log,
  }).catch((error) => { throw databaseConnectionError(error, urls.migrate!); });
}
