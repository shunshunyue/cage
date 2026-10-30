// @yss123/cage-lint：ESLint 插件与推荐配置。项目里的 eslint.config.js：
//   import cage from '@yss123/cage-lint';
//   export default [...cage.configs.recommended];
import tsParser from '@typescript-eslint/parser';
import type { ESLint, Linter } from 'eslint';
import noManualRoutes from './rules/no-manual-routes.js';
import noSecretLiteral from './rules/no-secret-literal.js';
import noSqlConcat from './rules/no-sql-concat.js';
import unsafeNeedsReason from './rules/unsafe-needs-reason.js';

export const rules = {
  'unsafe-needs-reason': unsafeNeedsReason,
  'no-sql-concat': noSqlConcat,
  'no-secret-literal': noSecretLiteral,
  'no-manual-routes': noManualRoutes,
};

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
