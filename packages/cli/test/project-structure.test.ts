/**
 * 验证模块化目录门禁及 TypeScript 导入边界。
 * 在独立临时项目中构造平铺源码、路径别名、转导出和合法公开入口，确保检查沿真实依赖解析。
 * 不执行项目代码；套件仅创建并清理自身临时目录。
 */
// 定向验证脚手架目录门禁：真实反例能被定位，正确的组合和公开入口保持可用。
import { afterAll, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { checkProjectStructure } from '../src/project-structure.js';

const temporary = mkdtempSync(join(tmpdir(), 'cage-structure-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

/**
 * 建立启用 modular 门禁且配置 @/* 别名的临时项目，再覆盖用例指定源码。
 * 文件均位于当前测试目录，返回 CageConfig 供静态分析，不执行这些模块。
 */
function project(name: string, files: Record<string, string>) {
  const root = join(temporary, name);
  const put = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  put('cage.config.json', '{"structure":"modular"}');
  put('packages/domain/src/index.ts', 'export {};');
  put(
    'apps/web/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        moduleResolution: 'Bundler',
        baseUrl: '.',
        paths: { '@/*': ['src/*'] },
      },
    }),
  );
  for (const [file, source] of Object.entries(files)) put(file, source);
  return loadConfig(root);
}

it('平铺业务被指出，旧项目可以在整理后选择开启检查', () => {
  const cfg = project('flat', {
    'apps/web/src/lists.tsx': 'export {};',
    'packages/domain/src/expense.ts': 'export {};',
  });
  expect(checkProjectStructure(cfg).map((f) => [f.code, f.at])).toEqual([
    ['CAGE-STRUCT-001', 'packages/domain/src/expense.ts'],
    ['CAGE-STRUCT-001', 'apps/web/src/lists.tsx'],
  ]);
  expect(checkProjectStructure({ ...cfg, structure: undefined })).toEqual([]);
});

it('别名和转导出不能绕过 shared 及模块边界', () => {
  const cfg = project('invalid-dependencies', {
    'apps/web/src/modules/expense/pages/expense-page.tsx': 'export const ExpensePage = 1;',
    'apps/web/src/shared/lib/expense.ts':
      "export { ExpensePage } from '@/modules/expense/pages/expense-page';",
    'apps/web/src/app/app.tsx': "import { ExpensePage } from '../modules/expense/pages/expense-page';",
    'apps/web/src/modules/purchase/index.ts': "export { ExpensePage } from '../expense/pages/expense-page';",
    'packages/domain/src/workflows/expense.ts': 'export const flow = 1;',
    'packages/domain/src/modules/expense/expense.ts': "import { flow } from '../../workflows/expense.js';",
  });
  const findings = checkProjectStructure(cfg);
  expect(findings).toHaveLength(4);
  expect(findings.every((f) => f.code === 'CAGE-STRUCT-002')).toBe(true);
  expect(findings.map((f) => f.at)).toContain('apps/web/src/shared/lib/expense.ts:1');
});

it('应用组合、模块内部拆分和领域单向公开依赖合法', () => {
  const cfg = project('modular', {
    'apps/web/src/main.tsx': "import { App } from './app/app';",
    'apps/web/src/app/app.tsx': "import { Page } from '../modules/expense'; export const App = Page;",
    'apps/web/src/modules/expense/index.ts': "export { Page } from './expense-page';",
    'apps/web/src/modules/expense/expense-page.tsx':
      "import { format } from '../../shared/lib/format'; export const Page = format;",
    'apps/web/src/shared/lib/format.ts': 'export const format = 1;',
    'packages/domain/src/modules/inventory/index.ts': 'export const Inventory = 1;',
    'packages/domain/src/modules/purchase/purchase.ts': "import { Inventory } from '../inventory/index.js';",
    'packages/domain/src/modules/purchase/purchase.test.ts': "import pg from 'pg'; // 测试可以装配基础设施",
  });
  expect(checkProjectStructure(cfg)).toEqual([]);
});
