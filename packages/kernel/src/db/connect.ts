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

export interface DbHandle {
  db: Kysely<any>;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function connect(
  url: string,
  opts: { max?: number; onConnect?: (c: pg.PoolClient) => Promise<void>; applicationName?: string } = {},
): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10, types: types as any, application_name: opts.applicationName ?? 'cage' });
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
export async function dedicatedClient(url: string, applicationName = 'cage-listener'): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, types: types as any, application_name: applicationName });
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
