// 将非法准备数据与实际执行故障分开；固定种子和已观察失败前缀用于重放，诊断一律脱敏。
import { aggregate, command, fail, int, scope, text } from '@yss123/cage-kernel';
import * as org from '@yss123/cage-admin/domain';
import { expect, it } from 'vitest';
import { derived, DerivedTestError, type DerivedInvariantResult, type DerivedOptions } from '../src/index.js';

const Budget = aggregate('DerivedBudget', {
  fields: { total: int(), available: int(), frozen: int(), currency: text(3), phone: text(80).sensitive('phone').optional() },
  scope: scope.none(),
  invariants: { conserved: (row) => row.total === row.available + row.frozen, cny: (row) => row.currency === 'CNY' },
});
const freeze = command(Budget, { name: 'freeze', from: 'active', to: null, handler: (row) => row.available < 1 ? fail('NO_AVAILABLE') : { available: row.available - 1, frozen: row.frozen + 1 } });
const release = command(Budget, { name: 'release', from: 'active', to: null, handler: (row) => row.frozen < 1 ? fail('NOT_FROZEN') : { available: row.available + 1, frozen: row.frozen - 1 } });
const domain = { ...org, Budget, freeze, release };
const valid = { total: 5, available: 5, frozen: 0, currency: 'CNY', phone: 'PRIVATE_FIXTURE_MARKER' };

it('默认样本不满足预算不变量时明确报告fixture阶段，未执行业务命令', async () => {
  const test = derived(domain, { seed: 123 });
  await test.setup();
  try {
    await expect(test.invariantsHold(Budget.name, 1)).rejects.toMatchObject({ code: 'CAGE-TEST-002', phase: 'fixture', aggregate: Budget.name, seed: 123,
      detail: { failedInvariants: expect.arrayContaining(['conserved', 'cny']), commands: [], minimalPrefix: [] } });
  } finally { await test.teardown(); }
});

it('显式非法夹具保留失败不变量和可定位数据，敏感标记不进入异常或详情', async () => {
  const test = derived(domain, { fixtures: { DerivedBudget: { ...valid, total: 6 } } });
  await test.setup();
  try {
    let caught: DerivedTestError | null = null;
    try { await test.invariantsHold(Budget.name, 1); } catch (e) { caught = e as DerivedTestError; }
    expect(caught).toBeInstanceOf(DerivedTestError);
    expect(caught!.detail.initial).toMatchObject({ total: 6, available: 5, frozen: 0, phone: '[REDACTED]' });
    expect(caught!.message).not.toContain('PRIVATE_FIXTURE_MARKER');
    expect(JSON.stringify(caught!.detail)).not.toContain('PRIVATE_FIXTURE_MARKER');
  } finally { await test.teardown(); }
});

it('合法fixture钩子和同一seed在新环境中稳定重放命令选择及输入', async () => {
  const options: DerivedOptions = { seed: 9042, fixtures: { DerivedBudget: async ({ env, aggregate, uuid }) => env.insert(aggregate, { id: uuid(), ...valid }) } };
  const results: DerivedInvariantResult[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const test = derived(domain, options);
    await test.setup();
    try { results.push(await test.invariantsHold(Budget.name, 1) as DerivedInvariantResult); }
    finally { await test.teardown(); }
  }
  expect(results[0]).toMatchObject({ seed: 9042, steps: 4, violations: [] });
  expect(results[0].traces[0].commands).toEqual(results[1].traces[0].commands);
  expect(JSON.stringify(results)).not.toContain('PRIVATE_FIXTURE_MARKER');
});

it('执行内部故障带execution阶段和首个失败前缀，不输出原始错误中的敏感值', async () => {
  const test = derived(domain, { seed: 40, fixtures: { DerivedBudget: valid } });
  await test.setup();
  try {
    test.env().callAs = async () => { throw new Error('PRIVATE_FAILURE_MARKER'); };
    let caught: DerivedTestError | null = null;
    try { await test.invariantsHold(Budget.name, 1); } catch (e) { caught = e as DerivedTestError; }
    expect(caught).toMatchObject({ phase: 'execution', seed: 40 });
    expect(caught!.detail.commands).toHaveLength(1);
    expect(caught!.detail.minimalPrefix).toEqual(caught!.detail.commands);
    expect(caught!.message).not.toContain('PRIVATE_FAILURE_MARKER');
  } finally { await test.teardown(); }
});
