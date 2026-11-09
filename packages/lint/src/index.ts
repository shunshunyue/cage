/**
 * 导出 Cage ESLint 插件及面向业务项目的推荐规则。
 * 规则覆盖手写路由、SQL 拼接、疑似密钥和 unsafe 说明；依赖方向另由 dependency-cruiser 检查。
 * 推荐配置排除依赖、构建产物和生成契约，只做静态语法检查，不能替代运行时授权或业务测试。
 */
// @yss123/cage-lint：ESLint 插件与推荐配置。项目里的 eslint.config.js：
//   import cage from '@yss123/cage-lint';
//   export default [...cage.configs.recommended];
import tsParser from '@typescript-eslint/parser';
import type { ESLint, Linter } from 'eslint';
import noManualRoutes from './rules/no-manual-routes.js';
import noSecretLiteral from './rules/no-secret-literal.js';
import noSqlConcat from './rules/no-sql-concat.js';
import unsafeNeedsReason from './rules/unsafe-needs-reason.js';

/**
 * 公开规则表，键名供 cage/规则名 配置引用；统一实现由下方插件与推荐配置复用。
 */
export const rules = {
  'unsafe-needs-reason': unsafeNeedsReason,
  'no-sql-concat': noSqlConcat,
  'no-secret-literal': noSecretLiteral,
  'no-manual-routes': noManualRoutes,
};

/**
 * ESLint 插件对象先创建再填充 recommended，避免配置复制出另一套规则实例。
 */
const plugin: ESLint.Plugin & { configs: Record<string, Linter.Config[]> } = {
  meta: { name: '@yss123/cage-lint', version: '0.1.0' },
  rules: rules as any,
  configs: {},
};

plugin.configs.recommended = [
  { ignores: ['**/node_modules/**', '**/dist/**', 'generated/**', 'packages/contracts/**', '.cage/**'] },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    languageOptions: {
      parser: tsParser as any,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: { cage: plugin },
    rules: {
      'cage/unsafe-needs-reason': 'error',
      'cage/no-sql-concat': 'error',
      'cage/no-secret-literal': 'error',
      'cage/no-manual-routes': 'error',
    },
  },
];

export default plugin;
