/**
 * 内嵌 PostgreSQL 依赖的进程退出码兼容层，仅供 pg.ts 在加载 embedded-postgres 后安装。
 * embedded-postgres 注册的 async-exit-hook 2.x 将 beforeExit 固定转换为 process.exit(0)，
 * 会覆盖 Vitest 已设置的失败状态；本模块保留进入自然退出阶段时的非零码，供最终 exit 恢复。
 * 不替换 process.exit、不移除依赖的异步清理或信号处理，也不启动/停止数据库。
 * 只修正已知的非零状态被改为零：后续显式非零退出仍保留，beforeExit 之后新产生的失败不在此推断。
 */

/** 同一模块实例的进程级安装标记；多次创建内嵌数据库只注册一组兼容监听。 */
let installed = false;

/**
 * 安装一次失败退出码保留逻辑，供 startEmbeddedPostgres 紧接依赖加载后调用。
 * Node 自然退出时先传入当前退出码；若其非零，在 exit 阶段仅将上游强制的零恢复为该码。
 * 同步 exit 监听中只设置 process.exitCode，不执行异步 IO；因此数据库清理仍由原有钩子完成。
 * 调用无返回值、不修改公开接口；已有监听不会被删除，显式 process.exit(非零) 的结果不被覆盖。
 */
export function preserveEmbeddedPostgresExitCode(): void {
  if (installed) return;
  installed = true;
  process.once('beforeExit', (code) => {
    if (code === 0) return;
    // 上游在 nextTick 中调用 process.exit(0)，所以此处可先记录真实失败并等待最终退出事件。
    process.once('exit', (actual) => {
      if (actual === 0) process.exitCode = code;
    });
  });
}
