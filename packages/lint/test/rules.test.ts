/**
 * 对 Cage ESLint 推荐配置执行真实 lintText，覆盖 unsafe 说明、SQL 拼接、秘密字面量与手写业务路由。
 * 字符串片段是静态分析输入，不执行其中业务代码；正反例只证明当前语法规则覆盖，不能代替运行时安全检查。
 */
// 用真实 ESLint 执行规则：每个规则都有允许的业务写法和应当拦截的反例。
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import plugin from '../src/index.js';

/**
 * 关闭仓库外部配置查找，仅加载被测插件推荐配置，避免机器环境改变规则结果。
 */
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: plugin.configs.recommended });
/**
 * 以 domain 文件路径解析给定 TypeScript 片段并返回诊断，用于同时检查规则 ID、严重级别和允许的写法。
 */
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
