/**
 * 为业务项目声明模块依赖的禁止方向：domain 不直接 IO，适配器不直接写库，Web 不加载服务端运行时。
 * 生成契约和 generated 目录不能反向进入 domain，避免生成循环和职责倒置。
 * 路径正则面向脚手架目录布局，测试文件对 domain IO 规则有明确例外；配置只分析依赖，不改变打包或运行时权限。
 */
// 依赖规则（框架提供）：管「谁不能导入谁」。项目里的 .dependency-cruiser.cjs 只需要一行：
//   module.exports = require('@yss123/cage-lint/dependency-cruiser.cjs');
module.exports = {
  forbidden: [
    {
      name: 'domain-no-io',
      severity: 'error',
      comment: '[CAGE-DEP-001] 声明和 handler 不能直接做 IO',
      from: { path: '^packages/domain', pathNot: '\\.(test|spec)\\.' },
      to: {
        path: '^(node:)?(fs|net|http|https|http2|child_process|dgram|tls|worker_threads|cluster)$|node_modules/(pg|kysely|axios|undici|node-fetch|got)/|node_modules/@yss123/cage-(http|files)/',
      },
    },
    {
      name: 'adapters-write-via-commands',
      severity: 'error',
      comment: '[CAGE-DEP-002] 适配器必须通过命令网关写数据',
      from: { path: '^packages/adapters' },
      to: { path: 'node_modules/(pg|kysely)/' },
    },
    {
      name: 'web-only-contracts',
      severity: 'error',
      comment: '[CAGE-DEP-003] 前端只能依赖 @app/contracts',
      from: { path: '^apps/web' },
      to: { path: '^packages/domain|node_modules/@yss123/cage-(kernel|http|files|admin|connectors|approval|testkit|ai|ontology)/' },
    },
    {
      name: 'no-generated-imports-from-domain',
      severity: 'error',
      comment: '[CAGE-DEP-005] domain 不能依赖生成物',
      from: { path: '^packages/domain' },
      to: { path: '^(generated|packages/contracts)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: { path: '(^|/)(dist|generated/tests|node_modules)/' },
  },
};
