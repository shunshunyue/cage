// 数据库连接：内核账号（写）、读侧账号（只能看安全视图）、迁移账号（DDL）。
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// 类型解析：bigint 转数字（计数用），date 保持字符串（避免时区换算），numeric 保持字符串（金额）
const PARSERS: Record<number, (v: string) => unknown> = {
  20: (v) => Number(v), // int8
  1082: (v) => v, // date
};

const types = {
  getTypeParser(oid: number, format?: any) {
    const p = PARSERS[oid];
    return p ?? (pg.types.getTypeParser as any)(oid, format);
  },
};

/** 内核自建连接的所有权句柄；close 销毁 Kysely 及底层池，调用方不应继续复用它。 */
export interface DbHandle {
  db: Kysely<any>;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * 创建一个独立账号的连接池，所有超时均以毫秒计；构造池不等于已验证数据库可连通。
 * 读账号与写账号分别建池，避免会话权限混用。onConnect 是连接事件钩子，不承担迁移或账号初始化。
 * 默认的连接、语句、空闲事务时限让池耗尽和遗留事务可失败退出，不能用无限等待隐藏锁问题。
 */
export function connect(
  url: string,
  opts: { max?: number; onConnect?: (c: pg.PoolClient) => Promise<void>; applicationName?: string; connectionTimeoutMs?: number; statementTimeoutMs?: number; idleTransactionTimeoutMs?: number } = {},
): DbHandle {
  // 池耗尽和遗留事务都必须有界；加大连接池不能修复持有连接再等待同池连接的循环。
  const pool = new pg.Pool({
    connectionString: url, max: opts.max ?? 10, types: types as any, application_name: opts.applicationName ?? 'cage',
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: opts.idleTransactionTimeoutMs ?? 30_000,
  });
  if (opts.onConnect) pool.on('connect', (c) => void opts.onConnect!(c));
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}

/** 单独的长连接（LISTEN、咨询锁用），不进连接池 */
/** 成功返回已连接客户端；调用方必须 end，并在网络断开时重建 LISTEN/咨询锁状态。 */
export async function dedicatedClient(url: string, applicationName = 'cage-listener'): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, types: types as any, application_name: applicationName, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
  await c.connect();
  return c;
}

export interface DatabaseUrls {
  /** 内核账号 cage_app */
  app: string;
  /** 读侧账号 cage_read */
  read: string;
  /** 迁移账号 cage_migrate（只在 migrate 时使用） */
  migrate?: string;
}

/**
 * 从环境变量读取连接串：
 *   CAGE_APP_DATABASE_URL / CAGE_READ_DATABASE_URL / CAGE_MIGRATE_DATABASE_URL
 * 或只给一个 DATABASE_URL（主机、端口、库名），各账号用默认用户名和 CAGE_DB_PASSWORD。
 */
/**
 * 专用连接串优先于 DATABASE_URL 派生值；仅解析配置，不创建数据库、角色或重置密码。
 * 返回值含凭据，应只传给连接层，排障时提取主机/端口/库名而不要输出整个对象。
 */
export function urlsFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseUrls {
  const base = env.DATABASE_URL;
  const derive = (user: string, pwVar: string) => {
    if (!base) return undefined;
    const u = new URL(base);
    u.username = user;
    u.password = env[pwVar] ?? env.CAGE_DB_PASSWORD ?? user;
    return u.toString();
  };
  const app = env.CAGE_APP_DATABASE_URL ?? derive('cage_app', 'CAGE_APP_PASSWORD');
  const read = env.CAGE_READ_DATABASE_URL ?? derive('cage_read', 'CAGE_READ_PASSWORD');
  const migrate = env.CAGE_MIGRATE_DATABASE_URL ?? derive('cage_migrate', 'CAGE_MIGRATE_PASSWORD');
  if (!app || !read) {
    throw new Error('[CAGE-ENV-001] 缺少数据库连接：设置 DATABASE_URL，或 CAGE_APP_DATABASE_URL 与 CAGE_READ_DATABASE_URL');
  }
  return { app, read, migrate };
}
