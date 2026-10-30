// 开发数据库的环境配置与 Docker 生命周期属于框架工具链。
// 业务仓库只保留 compose.yaml/.env 等部署参数，不维护连接、建库或凭证生成脚本。
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { abs, type CageConfig } from './config.js';
import { migrate } from './migrate.js';

/** 首次为项目生成独立凭证；已有配置保持原样，避免与持久卷中的角色密码失配。 */
export function setupDatabase(cfg: CageConfig): boolean {
  const target = abs(cfg, '.env');
  if (existsSync(target)) return false;
  const secret = () => randomBytes(24).toString('hex');
  const passwords = { postgres: secret(), test: secret(), app: secret(), read: secret(), migrate: secret() };
  const port = cfg.devDbPort;
  const url = (user: string, password: string, port: number, database: string) =>
    `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const content = [
    '# 仅供本地开发，由 cage db setup 生成；不要提交或复制进镜像。',
    `CAGE_POSTGRES_PORT=${port}`,
    `CAGE_TEST_POSTGRES_PORT=${port + 1}`,
    `POSTGRES_PASSWORD=${passwords.postgres}`,
    `CAGE_TEST_POSTGRES_PASSWORD=${passwords.test}`,
    `CAGE_SUPER_DATABASE_URL=${url('postgres', passwords.postgres, port, 'postgres')}`,
    `CAGE_APP_DATABASE_URL=${url('cage_app', passwords.app, port, 'cage_dev')}`,
    `CAGE_READ_DATABASE_URL=${url('cage_read', passwords.read, port, 'cage_dev')}`,
    `CAGE_MIGRATE_DATABASE_URL=${url('cage_migrate', passwords.migrate, port, 'cage_dev')}`,
    '# 测试会初始化集群角色，必须使用独立的可丢弃测试集群。',
    `CAGE_TEST_DATABASE_URL=${url('postgres', passwords.test, port + 1, 'postgres')}`,
    `CAGE_COOKIE_SECRET=${secret()}`,
    'CAGE_STAGE=fake',
    'CAGE_WEB_PORT=5173',
    'PORT=3000',
    'HOST=127.0.0.1',
    '',
  ].join('\n');
  writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  return true;
}

/** Docker 仅负责基础设施，建库、账号权限和迁移仍复用框架现有 migrate 流程。 */
export async function database(cfg: CageConfig, action?: string): Promise<number> {
  if (action === 'setup') {
    console.log(
      setupDatabase(cfg)
        ? '已生成 .env（不输出密码）。随后运行 cage db up、cage db init、cage dev。'
        : '已有 .env，保留当前数据库配置。',
    );
    return 0;
  }
  if (action === 'init') {
    await migrate(cfg, true);
    return 0;
  }
  // 参数列表由命令固定，不接受任意 shell 文本；down 不删除持久卷。
  const actions: Record<string, string[]> = {
    up: ['up', '-d', '--wait'],
    down: ['down'],
    status: ['ps'],
  };
  if (!action || !actions[action]) throw new Error('用法：cage db setup|up|init|status|down');
  const child = spawn('docker', ['compose', '--profile', 'test', ...actions[action]], {
    cwd: cfg.root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
