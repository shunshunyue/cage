// 用真实 ESLint 执行规则：每个规则都有允许的业务写法和应当拦截的反例。
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import plugin from '../src/index.js';

const lint = new ESLint({ overrideConfigFile: true, overrideConfig: plugin.configs.recommended });
const messages = async (code: string) =>
  (await lint.lintText(code, { filePath: 'packages/domain/src/sample.ts' }))[0].messages;

describe('Cage ESLint 规则', () => {
  it.each([
    ["unsafe({ reason: '', owner: 'someone' });", 'cage/unsafe-needs-reason'],
    ["const sqlText = 'select * from safe.orders where id = ' + id;", 'cage/no-sql-concat'],
    ['sql.raw(input);', 'cage/no-sql-concat'],
    ["const password = 'this-is-an-insecure-literal';", 'cage/no-secret-literal'],
    ["app.post('/api/order/approve', handler);", 'cage/no-manual-routes'],
  ])('阻断 %s', async (code, ruleId) => {
    expect(await messages(code)).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId, severity: 2 })]),
    );
  });
  it.each([
    "unsafe({ reason: '迁移遗留数据', owner: '数据组' });",
    'const query = sql`select * from safe.orders where id = ${id}`;',
    "const secret = 'ERP_API_TOKEN';",
    'const password = process.env.PASSWORD;',
    'const order = await deps.orders.get(id);',
  ])('允许 %s', async (code) => {
    expect(await messages(code)).toEqual([]);
  });
});
