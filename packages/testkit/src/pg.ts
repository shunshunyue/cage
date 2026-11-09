/**
 * 内嵌真实 PostgreSQL 的测试进程与目录生命周期管理。
 * 启动临时或显式持久实例，使用路径和归属标记约束停止/删除目标；Windows 通过 pg_ctl 关闭本次实例。
 * 业务 dev 不使用这里自动建库，测试连接选择由上层 env/globalSetup 负责；目录和管理员连接只供受控测试。
 * 加载上游依赖后安装退出码兼容层，避免其异步清理钩子把已有测试失败改为成功退出。
 */
// 测试与本地开发用的 PostgreSQL：优先使用 CAGE_TEST_DATABASE_URL（超级用户连接串，例如 CI 里的服务容器），
// 否则启动 embedded-postgres（npm 包自带真实的 PostgreSQL 二进制，不需要 Docker）。
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import pg from 'pg';
import { preserveEmbeddedPostgresExitCode } from './embedded-exit.js';

/**
 * 内嵌实例句柄：host/port 定位本地监听，superUrl 是测试管理员连接。
 * stop 幂等关闭本次实例并按 persistent 决定目录清理，不按进程名停止其他 PostgreSQL。
 */
export interface PgInstance {
  /** 超级用户连接串（指向 postgres 库） */
  superUrl: string;
  host: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * 让系统在回环地址分配临时端口，关闭探测 socket 后返回端口号。
 * 该结果是当时空闲端口，不在函数返回后持续占用；后续启动仍可能遇到竞争并失败。
 */
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

/**
 * 启动测试 PostgreSQL；dir/port 可显式指定，persistent 默认 false，log 决定是否转发进程日志。
 * 拒绝根目录和把已有数据库目录作为可自动删除临时目录；启动后记录真实路径及唯一归属令牌。
 * stop 在关闭前后核对目录归属，Windows 还核对服务报告的数据目录和端口；归属不符时拒绝清理。
 * 临时目录删除有界重试以等待文件句柄释放，失败抛出；持久目录只移除本次归属标记。
 */
export async function startEmbeddedPostgres(opts: { dir?: string; port?: number; persistent?: boolean; log?: boolean } = {}): Promise<PgInstance> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  // 依赖仅被导入就注册固定退出码的钩子；在创建实例前保留失败状态，初始化失败同样不能变成成功。
  preserveEmbeddedPostgresExitCode();
  const port = opts.port ?? (await freePort());
  const persistent = opts.persistent ?? false;
  const dir = resolve(opts.dir ?? mkdtempSync(join(tmpdir(), 'cage-pg-')));
  if (dir === parse(dir).root) throw new Error('[CAGE-TEST-003] 内嵌 PostgreSQL 目录不能是文件系统根目录');
  const fresh = !existsSync(join(dir, 'PG_VERSION'));
  if (!persistent && !fresh) throw new Error('[CAGE-TEST-003] 不允许将已有 PostgreSQL 目录作为自动删除的临时实例；使用 persistent: true');
  if (persistent) mkdirSync(dir, { recursive: true });
  const instance = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    // 目录清理由本包装层负责。上游在 Windows 杀进程后立即删目录，没有处理
    // 文件句柄释放的短暂延迟；保留目录再由 stop() 做有界重试，失败仍明确抛出。
    persistent: true,
    onLog: opts.log ? (m: string) => process.stdout.write(m) : () => {},
    onError: opts.log ? (m: unknown) => process.stderr.write(String(m)) : () => {},
  });
  if (fresh) await instance.initialise();
  await instance.start();
  const ownedDir = await realpath(dir);
  const marker = join(ownedDir, '.cage-testkit-owner');
  const token = randomUUID();
  await writeFile(marker, token, 'utf8');
  const superUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  let stopping: Promise<void> | null = null;
  const upstreamStop = instance.stop.bind(instance);
  const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  const stopOwned = async () => {
    // 只关闭本包装器刚启动的实例，不能按进程名终止机器上其他 PostgreSQL。
    if (!samePath(await realpath(dir), ownedDir) || (await readFile(marker, 'utf8')) !== token) throw new Error('[CAGE-TEST-003] 临时 PostgreSQL 目录归属变化，拒绝停止或删除');
    if (process.platform === 'win32') {
      const client = new pg.Client({ connectionString: superUrl, connectionTimeoutMillis: 2_000, statement_timeout: 2_000 });
      try {
        await client.connect();
        const { rows } = await client.query("select current_setting('data_directory') as directory, current_setting('port')::int as port");
        if (!samePath(await realpath(rows[0].directory), ownedDir) || rows[0].port !== port) throw new Error('[CAGE-TEST-003] PostgreSQL 实际目录或端口与本次实例不符');
      } finally { await client.end(); }
      // 平台包公开导出 pg_ctl；不用上游的私有 process，也不用会被沙箱阻断的 taskkill。
      // Vite 的 globalSetup 不实现 import.meta.resolve；使用 Node 的公开模块解析接口。
      const requireEmbedded = createRequire(createRequire(import.meta.url).resolve('embedded-postgres'));
      const binaries = await import(pathToFileURL(requireEmbedded.resolve(`@embedded-postgres/windows-${process.arch}`)).href) as { pg_ctl: string };
      await promisify(execFile)(binaries.pg_ctl, ['-D', ownedDir, '-m', 'fast', '-w', '-t', '10', 'stop'], { windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024 });
    } else {
      await upstreamStop();
    }
    // 删除前再次核对绝对路径与归属标记，保留调用者要求的持久目录。
    if (!samePath(await realpath(dir), ownedDir) || (await readFile(marker, 'utf8')) !== token) throw new Error('[CAGE-TEST-003] 停止后目录归属变化，拒绝删除');
    if (persistent) await unlink(marker);
    else await rm(ownedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  // 上游退出钩子仍会调用这个公开 stop；幂等包装避免重复等待已经退出的子进程。
  instance.stop = () => stopping ??= stopOwned();
  return {
    superUrl,
    host: '127.0.0.1',
    port,
    stop: () => instance.stop(),
  };
}

/** 把超级用户连接串换成另一个库、另一个账号 */
/**
 * 复制并改写连接 URL 的数据库路径，可选替换账号与密码，保留主机及其他 URL 参数。
 * 仅返回字符串，不建立连接、创建数据库或验证账号；调用方不得把含凭据结果写入日志。
 */
export function withDb(url: string, db: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}
