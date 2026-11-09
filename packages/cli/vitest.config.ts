/**
 * CLI 包测试入口，只扫描本包 test 目录，避免重复执行随 npm 分发的模板测试。
 * 单用例默认允许 30 秒；隔离数据库等较慢夹具在测试文件内显式设置超时。
 * 本配置不注入数据库或运行环境，具体资源由各套件建立和释放。
 */
import { defineConfig } from 'vitest/config';

// 发布资源中也带示例测试；这些测试在生成项目里执行，CLI 自测只扫描 test/。
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
