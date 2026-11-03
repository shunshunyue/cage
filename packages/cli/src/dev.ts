// 本地开发只编排 API、worker 和 Vite，数据库由使用方提供。
// 缺少连接配置就报错，不自动启动数据库；表结构迁移由开发者审查后单独执行。
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, type ChildProcess } from 'node:child_process';
import { urlsFromEnv } from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';
import { binPath, launch, run } from './process.js';

export async function dev(cfg: CageConfig): Promise<number> {
  const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    CAGE_STAGE: process.env.CAGE_STAGE ?? 'fake',
  };
  // 项目包的 development 导出指向源码，tsx watch 才能观察到 domain 的修改。
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --conditions=development`.trim();
  const urls = urlsFromEnv(env);
  const children: ChildProcess[] = [];
  const watchers: ReturnType<typeof watch>[] = [];
  let finish!: (code: number) => void;
  let stopping = false;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  // 所有退出路径共用一次清理，避免子进程退出事件与 Ctrl+C 重复关闭应用进程。
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const watcher of watchers) watcher.close();
    for (const child of children) {
      // Windows 没有 POSIX 进程组；tsx watch 有子进程，需要按本次启动的 PID 清理整棵树。
      if (process.platform === 'win32' && child.pid && child.exitCode === null) {
        await new Promise<void>((resolve) =>
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () =>
            resolve(),
          ),
        );
      } else child.kill();
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once('exit', () => resolve())),
      ),
    );
    finish(code);
  };
  const onSignal = () => {
    void stop(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    // 抽取器用独立进程，声明改动不会被 Node 的模块缓存吞掉。
    if (await run(cli, ['gen'], cfg.root, env)) throw new Error('声明生成失败');
    const target = new URL(urls.app);
    console.log(
      `连接数据库 ${target.hostname}:${target.port || '5432'}${target.pathname}；表结构变更请审查后单独运行 pnpm exec cage migrate。`,
    );
    // API/worker 只需要业务及只读连接；迁移、测试和旧版管理员凭证不传给运行时。
    const runtimeEnv = { ...env };
    for (const key of [
      'CAGE_ADMIN_DATABASE_URL',
      'CAGE_SUPER_DATABASE_URL',
      'CAGE_MIGRATE_DATABASE_URL',
      'CAGE_MIGRATE_PASSWORD',
      'CAGE_TEST_DATABASE_URL',
      'CAGE_TEST_SUPER_URL',
      'POSTGRES_PASSWORD',
      'CAGE_TEST_POSTGRES_PASSWORD',
    ])
      delete runtimeEnv[key];
    const start = (file: string, args: string[], cwd = cfg.root) => {
      const child = launch(file, args, cwd, runtimeEnv);
      children.push(child);
      child.once('error', (error) => {
        console.error(error.message);
        void stop(1);
      });
      child.once('exit', (code) => {
        if (!stopping) void stop(code ?? 1);
      });
      return child;
    };
    // tsx watch 负责 API/worker 热重启；domain 的生成任务串行，避免同时覆盖生成文件。
    start(binPath('tsx'), ['watch', abs(cfg, cfg.apiEntry)]);
    start(binPath('tsx'), ['watch', abs(cfg, cfg.workerEntry)]);
    const req = createRequire(abs(cfg, `${cfg.web}/package.json`));
    const vite = join(dirname(req.resolve('vite/package.json')), 'bin/vite.js');
    start(vite, ['--host', '127.0.0.1'], abs(cfg, cfg.web));
    let pending = Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    watchers.push(
      watch(dirname(abs(cfg, cfg.domain)), { recursive: true }, (_event, name) => {
        if (!name || !/\.tsx?$/.test(String(name)) || /\.(test|spec)\.tsx?$/.test(String(name))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          pending = pending.then(async () => {
            if (stopping) return;
            if ((await run(cli, ['gen'], cfg.root, env)) === 0) console.log('声明已生成；若有表结构变更，请审查迁移后运行 pnpm exec cage migrate。');
          });
        }, 250);
      }),
    );
    const apiPort = env.PORT ?? '3000';
    console.log(
      `API http://localhost:${apiPort} · 管理 http://localhost:${apiPort}/admin · Web http://localhost:${env.CAGE_WEB_PORT ?? '5173'}`,
    );
    return await done;
  } finally {
    await stop(0);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
