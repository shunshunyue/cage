/**
 * 迁移命令适配层，从环境取得迁移账号并按当前领域注册表执行结构迁移。
 * 只连接已有数据库，读取迁移目录后交给 kernel runMigrations 校验历史并应用新迁移。
 * 不隐式准备账号或创建数据库；常见连接错误只输出主机、端口、库名及修复方向，不泄露密码。
 */
// 迁移只更新已有数据库的表、视图；账号权限由 cage init 准备，不在迁移中隐式修改。
import { readMigrations, runMigrations } from '@yss123/cage-kernel/db';
import { urlsFromEnv } from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';
import { loadRegistry } from './load.js';

/** 给首次使用者可执行的步骤，只展示地址和库名，绝不输出连接串中的密码。 */
/**
 * 将常见连接错误翻译为不含凭据的诊断。
 * @param error 原始连接错误。
 * @param databaseUrl 仅提取主机、端口与库名。
 * @returns 已知错误的新 Error 并保留 cause；未知 Error 原样返回，其他值转换为 Error。
 */
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

/**
 * 使用专用迁移账号应用内核和项目迁移，不隐式 init。
 * @param cfg 领域入口与迁移目录配置。
 * @param env 连接来源，默认当前环境。
 * @returns 内核迁移 Promise；缺少连接或执行失败抛出，不创建数据库。
 */
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
