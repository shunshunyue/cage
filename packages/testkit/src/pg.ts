// 测试与本地开发用的 PostgreSQL：优先使用 CAGE_TEST_DATABASE_URL（超级用户连接串，例如 CI 里的服务容器），
// 否则启动 embedded-postgres（npm 包自带真实的 PostgreSQL 二进制，不需要 Docker）。
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PgInstance {
  /** 超级用户连接串（指向 postgres 库） */
  superUrl: string;
  host: string;
  port: number;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port as number;
      s.close(() => resolve(port));
    });
  });
}

export async function startEmbeddedPostgres(opts: { dir?: string; port?: number; persistent?: boolean; log?: boolean } = {}): Promise<PgInstance> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = opts.port ?? (await freePort());
  const persistent = opts.persistent ?? false;
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'cage-pg-'));
  const fresh = !existsSync(join(dir, 'PG_VERSION'));
  if (persistent) mkdirSync(dir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent,
    onLog: opts.log ? (m: string) => process.stdout.write(m) : () => {},
    onError: opts.log ? (m: unknown) => process.stderr.write(String(m)) : () => {},
  });
  if (fresh) await pg.initialise();
  await pg.start();
  return {
    superUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    host: '127.0.0.1',
    port,
    async stop() {
      await pg.stop();
      if (!persistent) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 把超级用户连接串换成另一个库、另一个账号 */
export function withDb(url: string, db: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}
