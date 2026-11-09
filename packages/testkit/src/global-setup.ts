/**
 * Vitest 测试运行共享的 PostgreSQL 启停入口。
 * 已有 CAGE_TEST_DATABASE_URL 时仅转交测试管理员地址；否则启动本次内嵌集群并在全局结束时关闭。
 * 每个测试环境仍创建独立数据库，共享集群不等于共享业务记录。
 */
// Vitest globalSetup：整个测试运行只启动一个 PostgreSQL，每个测试文件各建一个临时库。
//   // vitest.config.ts
//   export default { test: { globalSetup: ['@yss123/cage-testkit/global-setup'] } }
import { startEmbeddedPostgres, type PgInstance } from './pg.js';

let instance: PgInstance | null = null;

/**
 * 准备测试进程可见的 CAGE_TEST_SUPER_URL 并返回 teardown 回调。
 * 外部集群分支不负责停止外部服务；内嵌分支等待 stop 完成后清空实例引用，清理异常向测试框架传播。
 */
export default async function setup() {
  if (process.env.CAGE_TEST_DATABASE_URL) {
    process.env.CAGE_TEST_SUPER_URL = process.env.CAGE_TEST_DATABASE_URL;
    return async () => {};
  }
  instance = await startEmbeddedPostgres();
  process.env.CAGE_TEST_SUPER_URL = instance.superUrl;
  return async () => {
    await instance?.stop();
    instance = null;
  };
}
