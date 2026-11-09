/**
 * 内核体积预算的回归测试：中文注释不能增加实现行数，真实代码超限仍必须拒绝。
 * 在独立临时目录建立最小 kernel 源码，通过公开 budget 入口验证原始物理行计数。
 * 覆盖注释内伪代码、字符串／正则中的注释符、跨行模板和 5000 行边界；不连接数据库。
 */
import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budget } from '../src/budget.js';
import { loadConfig } from '../src/config.js';
import { extract } from '../src/ontology.js';
import { buildRegistry } from '@yss123/cage-kernel';

const directory = mkdtempSync(join(tmpdir(), 'cage-budget-'));
const kernel = join(directory, 'packages/kernel/src');
mkdirSync(kernel, { recursive: true });
const cfg = loadConfig(directory);
const graph = extract(buildRegistry({}));
// 只移除本测试 mkdtemp 创建的绝对路径，不触及仓库或现有数据库。
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** 写入本测试唯一源文件后走完整预算入口，避免测试私有计数实现的相同算法。 */
function measure(source: string) {
  writeFileSync(join(kernel, 'fixture.ts'), source);
  return budget(cfg, graph);
}

it('新增大量中文 JSDoc 和普通注释不会触发实现体积超限', () => {
  const code = 'export const value = 1;\n';
  const before = measure(code);
  const annotated = '/**\n' + ' * 中文说明：@param input 输入；返回结果和失败边界。\n'.repeat(5_001) + ' */\n'
    + '// 只有注释的行\n\n/* 注释内伪代码：export const hidden = 2; */\n'
    + code.trimEnd() + ' // 行尾说明\n';
  expect(measure(annotated)).toEqual(before);
  expect(before.metrics.kernelLines).toBe(1);
});

it('保留字面量中的注释符及跨行模板的真实代码行', () => {
  const source = [
    'export const url = "https://example.com/*path*/";',
    'export const marker = /[/*]/;',
    'export const template = `第一行',
    '// 这是模板内容',
    '',
    '/* 这也是模板内容 */',
    '${url /* 插值内部的注释不影响代码行 */}',
    '`;',
    '/** 只有注释，不计数 */',
    'export const last = 2; /* 行尾注释',
    '延续的注释不计数 */',
  ].join('\r\n');
  expect(measure(source).metrics.kernelLines).toBe(9);
});

it('维持 5000 行边界并拒绝第 5001 行真实代码', () => {
  const code = Array.from({ length: 5_000 }, (_, index) => `export const value${index} = ${index};`).join('\n');
  expect(measure(code).findings).not.toContainEqual(expect.objectContaining({ code: 'CAGE-BUDGET-001' }));
  const exceeded = measure(code + '\nexport const extra = 1;');
  expect(exceeded.metrics.kernelLines).toBe(5_001);
  expect(exceeded.findings).toContainEqual(expect.objectContaining({ code: 'CAGE-BUDGET-001' }));
});
