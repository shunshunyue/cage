/**
 * 真实 PostgreSQL 集成回归的 Vitest 配置。
 * 全局准备测试集群，测试文件按配置隔离与清理；超时预算用于真实 IO，不将超时转为测试通过。
 */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['./src/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
  },
});
