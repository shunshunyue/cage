import { defineConfig } from 'vitest/config';

// 发布资源中也带示例测试；这些测试在生成项目里执行，CLI 自测只扫描 test/。
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
