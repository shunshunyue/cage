// 用预算、独占资源和后置凭证失败验证集合真正经过命令事务，覆盖真实租赁案例的关键保证。
import { randomUUID } from 'node:crypto';
import { aggregate, bool, buildRegistry, command, createKernel, emit, event, fail, id, int, list, reaction, reactionEach, reactionInputs, registryFingerprint, scope, silentLogger, states, text, type TxMode } from '@yss123/cage-kernel';
import { createWorker, deliver, reactionConsumers, type OutboxRow } from '@yss123/cage-kernel/worker';
import * as org from '@yss123/cage-admin/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestEnv, type TestEnv } from '../src/index.js';

/** 预算用整数测试单位避免金额精度干扰；available/frozen 均不得为负，以便观察冻结与回滚。 */
const Budget = aggregate('CollectionBudget', { fields: { available: int(), frozen: int() }, scope: scope.none(), invariants: { nonNegative: (row) => row.available >= 0 && row.frozen >= 0 } });
/** 独占资源只能 available→reserved，用行锁和状态冲突模拟两个申请竞争同一设备。 */
const Asset = aggregate('CollectionAsset', { fields: { label: text(40) }, states: states('available', 'reserved'), scope: scope.none() });
/** 明细与末尾凭证分别观察集合创建是否完整，以及最后一步失败能否撤销前面全部工作。 */
const Line = aggregate('CollectionLine', { fields: { label: text(40) }, scope: scope.none() });
const Ticket = aggregate('CollectionTicket', { fields: { label: text(40) }, scope: scope.none() });
/** 申请快照含预算、资源 ID、明细 ID/标签和故障开关 failLate；只由测试控制开关，不模拟真实业务字段。 */
const Allocation = aggregate('CollectionAllocation', { fields: {
  budgetId: id(), amount: int(), assets: list({ assetId: id() }), lines: list({ lineId: id(), label: text(40) }), failLate: bool(),
}, scope: scope.none() });
/** 保留创建时的集合内容，后续反应不能依赖外部可变数组；事件载荷同时覆盖单项和集合步骤。 */
const Requested = event('CollectionRequested', { budgetId: id(), amount: int(), assets: list({ assetId: id() }), lines: list({ lineId: id(), label: text(40) }), failLate: bool() });
const allocate = command(Allocation, { from: 'new', to: 'active', input: z.object({ budgetId: z.uuid(), amount: z.number().int().positive(), assets: z.array(z.object({ assetId: z.uuid() })), lines: z.array(z.object({ lineId: z.uuid(), label: z.string() })), failLate: z.boolean() }), handler: (draft) => draft, emits: [emit(Requested, (row) => row)] });
const freeze = command(Budget, { from: 'active', to: null, invokedBy: 'process', input: z.object({ id: z.uuid(), amount: z.number().int().positive() }), handler: (row, input) => row.available < input.amount ? fail('BUDGET_SHORT') : { available: row.available - input.amount, frozen: row.frozen + input.amount } });
const reserve = command(Asset, { from: 'available', to: 'reserved', invokedBy: 'process', handler: () => ({}) });
const addLine = command(Line, { from: 'new', to: 'active', invokedBy: 'process', input: z.object({ id: z.uuid(), label: z.string() }), handler: (row) => row });
const issue = command(Ticket, { from: 'new', to: 'active', invokedBy: 'process', input: z.object({ label: z.string(), failLate: z.boolean() }), handler: (row, input) => input.failLate ? fail('LATE_FAILURE') : row });
/** 顺序固定为冻结预算、按稳定键占资源、创建明细、出凭证；步骤序号与对象导出顺序刻意不同。 */
const budgetFirst = reaction(Requested, { command: freeze, order: 10, tx: 'same', map: (payload) => ({ id: payload.budgetId, amount: payload.amount }) });
const assetsSecond = reactionEach(Requested, { command: reserve, order: 20, tx: 'same', maxItems: 20, orderBy: 'assetId', items: (payload) => payload.assets, map: (asset) => ({ id: asset.assetId }) });
const linesThird = reactionEach(Requested, { command: addLine, order: 30, tx: 'same', maxItems: 10, orderBy: 'lineId', items: (payload) => payload.lines, map: (line) => ({ id: line.lineId, label: line.label }) });
const voucherLast = reaction(Requested, { command: issue, order: 40, tx: 'same', map: (payload) => ({ label: 'voucher', failLate: payload.failLate }) });
// 倒序导出对象故意与执行顺序不同：运行顺序必须由 order 决定。
const domain = { ...org, Budget, Asset, Allocation, Line, Ticket, Requested, allocate, freeze, reserve, addLine, issue, voucherLast, linesThird, assetsSecond, budgetFirst };
let env: TestEnv;
beforeAll(async () => { env = await createTestEnv({ domain }); });
afterAll(async () => { await env?.close(); });

/** 创建独立资源与预算，集合故意反序输入；断言应依据 orderBy 的稳定排序，而非传入次序。 */
async function fixture(assetCount = 20, lineCount = 10) {
  const budget = await env.insert(Budget, { available: 100, frozen: 0 });
  const assets = [];
  for (let i = 0; i < assetCount; i++) assets.push({ assetId: (await env.insert(Asset, { status: 'available', label: `asset${i}` })).id as string });
  const lines = Array.from({ length: lineCount }, (_, index) => ({ lineId: randomUUID(), label: `line${index}` }));
  return { budgetId: budget.id, amount: 60, assets: assets.reverse(), lines: lines.reverse(), failLate: false };
}

/** 复用同一测试数据库但更换反应事务模式；skipFirst 让 null 映射后执行索引与原始/排序索引不同。 */
function variant(tx: TxMode, skipFirst = false) {
  return createKernel({ db: { app: env.kernel.app, read: env.kernel.readDb }, logger: silentLogger, domain: {
    ...domain,
    budgetFirst: reaction(Requested, { command: freeze, order: 10, tx, map: budgetFirst.map }),
    assetsSecond: reactionEach(Requested, { command: reserve, order: 20, tx, maxItems: 20, orderBy: 'assetId', items: (payload) => payload.assets,
      map: (asset, _payload, index) => skipFirst && index === 0 ? null : { id: asset.assetId } }),
    linesThird: reactionEach(Requested, { command: addLine, order: 30, tx, maxItems: 10, orderBy: 'lineId', items: (payload) => payload.lines, map: (line) => ({ id: line.lineId, label: line.label }) }),
    voucherLast: reaction(Requested, { command: issue, order: 40, tx, map: voucherLast.map }),
  } });
}

/**
 * 真库验证上限、重复键、资源竞争及中间/末尾失败的回滚，不只检查静态声明返回值。
 * same 与 outbox 两条路径分别核对错误中的执行索引、排序索引、原索引及稳定键。
 * 指纹场景只变选择器，确保 API/worker 不会把不同集合含义误判为同一份注册声明。
 */
describe('有界集合共同事务与显式执行顺序', () => {
  it('20个资源、10个明细按稳定键执行，完整通过命令、审计及outbox', async () => {
    const input = await fixture();
    const result = await env.kernel.execute('CollectionAllocation.allocate', input, env.system());
    const rows = await env.query('select aggregate_id from sys.audit_log where command=$1 order by id', ['CollectionAsset.reserve']);
    expect(rows.slice(-20).map((row) => row.aggregate_id)).toEqual(input.assets.map((asset) => asset.assetId).sort());
    const [budget] = await env.query('select * from core.collection_budget where id=$1', [input.budgetId]);
    expect(budget).toMatchObject({ available: 40, frozen: 60 });
    expect((await env.audit({ aggregateId: result.id })).filter((entry) => entry.result === 'ok')).toHaveLength(1);
    expect((await env.query('select * from core.collection_line where id=any($1::uuid[])', [input.lines.map((line) => line.lineId)]))).toHaveLength(10);
  });

  it('最后凭证失败回滚主单、预算、全部设备、明细、成功审计及事件', async () => {
    const input = await fixture();
    const before = (await env.query('select count(*)::int n from sys.outbox'))[0].n;
    const result = await env.callAs(env.system(), 'CollectionAllocation.allocate', { ...input, failLate: true });
    expect(result).toMatchObject({ ok: false, domainCode: 'LATE_FAILURE' });
    expect((await env.query('select * from core.collection_budget where id=$1', [input.budgetId]))[0]).toMatchObject({ available: 100, frozen: 0 });
    expect((await env.query('select status from core.collection_asset where id=any($1::uuid[])', [input.assets.map((asset) => asset.assetId)])).every((asset) => asset.status === 'available')).toBe(true);
    expect(await env.query('select * from core.collection_line where id=any($1::uuid[])', [input.lines.map((line) => line.lineId)])).toHaveLength(0);
    expect((await env.query('select count(*)::int n from sys.outbox'))[0].n).toBe(before);
  });

  it('中间项失败带索引，并把前面已经写入的资源和预算一起回滚', async () => {
    const input = await fixture(3, 1);
    const ordered = [...input.assets].sort((a, b) => a.assetId.localeCompare(b.assetId));
    await env.query('update core.collection_asset set status=$1 where id=$2', ['reserved', ordered[1].assetId]);
    const result = await env.callAs(env.system(), 'CollectionAllocation.allocate', input);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION', detail: { reaction: 'assetsSecond', itemIndex: 1 } });
    expect((await env.query('select status from core.collection_asset where id=$1', [ordered[0].assetId]))[0].status).toBe('available');
    expect((await env.query('select available from core.collection_budget where id=$1', [input.budgetId]))[0].available).toBe(100);
  });

  it('超限和重复键明确拒绝，预算冻结不遗留', async () => {
    for (const count of [21, 2]) {
      const input = await fixture(count, 1);
      if (count === 2) input.assets[1] = input.assets[0];
      const result = await env.callAs(env.system(), 'CollectionAllocation.allocate', input);
      expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      expect((await env.query('select frozen from core.collection_budget where id=$1', [input.budgetId]))[0].frozen).toBe(0);
    }
  });

  it('两单并发竞争同一设备仅一单成功，失败方的预算也回滚', async () => {
    const first = await fixture(1, 1), second = await fixture(1, 1);
    second.assets = first.assets;
    const results = await Promise.all([first, second].map((input) => env.callAs(env.system(), 'CollectionAllocation.allocate', input)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const budgets = await env.query('select available from core.collection_budget where id=any($1::uuid[]) order by available', [[first.budgetId, second.budgetId]]);
    expect(budgets.map((row) => row.available)).toEqual([40, 100]);
  });

  it('步骤混用隐式顺序或同序号在注册时直接拒绝', () => {
    expect(() => buildRegistry({ ...domain, extra: reaction(Requested, { command: issue, tx: 'same', map: () => null }) })).toThrow('CAGE-REACT-003');
    expect(() => buildRegistry({ ...domain, extra: reaction(Requested, { command: issue, tx: 'same', order: 20, map: () => null }) })).toThrow('CAGE-REACT-003');
  });

  it('只改集合选择器也会改变 API/worker 注册指纹', () => {
    const Selection = event('CollectionSelection', { first: list({ lineId: id(), label: text(40) }), second: list({ lineId: id(), label: text(40) }) });
    const shared = { command: addLine, maxItems: 10, orderBy: 'lineId' as const, map: (line: { lineId: string; label: string }) => ({ id: line.lineId, label: line.label }) };
    const first = reactionEach(Selection, { ...shared, items: (payload) => payload.first });
    const second = reactionEach(Selection, { ...shared, items: (payload) => payload.second });
    expect(first.map.toString()).toBe(second.map.toString());
    expect(registryFingerprint(buildRegistry({ ...domain, Selection, selected: first })))
      .not.toBe(registryFingerprint(buildRegistry({ ...domain, Selection, selected: second })));
  });

  it.each(['same', 'outbox'] as const)('%s 集合跳过 null 后仍同时报告执行索引、排序索引、原索引和稳定键', async (tx) => {
    const input = await fixture(3, 1);
    const ordered = [...input.assets].sort((a, b) => a.assetId.localeCompare(b.assetId));
    input.assets = [ordered[2], ordered[0], ordered[1]];
    const failing = ordered[2].assetId;
    await env.query('update core.collection_asset set status=$1 where id=$2', ['reserved', failing]);
    const k = variant(tx, true);
    expect(reactionInputs(k.registry.reactionsFor(Requested.name).find(({ name }) => name === 'assetsSecond')!.r, input))
      .toEqual([{ id: ordered[1].assetId }, { id: failing }]);
    let error: unknown;
    if (tx === 'same') {
      try { await k.execute('CollectionAllocation.allocate', input, env.system()); }
      catch (caught) { error = caught; }
    } else {
      const worker = createWorker(k);
      const allocation = await k.execute('CollectionAllocation.allocate', input, env.system());
      const [row] = await env.query('update sys.outbox set status=$1,locked_at=now() where aggregate_id=$2 and event=$3 returning *', ['processing', allocation.id, Requested.name]);
      expect(await deliver(k, { ...row, id: Number(row.id) } as OutboxRow, worker.consumers)).toBe('dead');
      error = JSON.parse((await env.query('select last_error from sys.outbox where id=$1', [row.id]))[0].last_error);
      expect(await env.query('select * from sys.processed_event where event_id=$1 and consumer=$2', [row.id, 'reaction:assetsSecond'])).toHaveLength(0);
    }
    expect(error).toMatchObject({ code: 'INVALID_TRANSITION', detail: {
      reaction: 'assetsSecond', itemIndex: 1, sortedIndex: 2, originalIndex: 0, itemKey: failing, order: 20, orderBy: 'assetId',
    } });
    expect((await env.query('select status from core.collection_asset where id=$1', [ordered[1].assetId]))[0].status).toBe('available');
    if (tx === 'same') expect((await env.query('select available from core.collection_budget where id=$1', [input.budgetId]))[0].available).toBe(100);
  });

  it('outbox 单项与集合按注册顺序串行消费，隐式同序保持导出顺序', async () => {
    const k = variant('outbox'), worker = createWorker(k);
    expect(worker.consumers.filter((consumer) => consumer.event === Requested.name).map((consumer) => consumer.name))
      .toEqual(k.registry.reactionsFor(Requested.name).map(({ name }) => `reaction:${name}`));
    const input = await fixture(2, 1), requestId = randomUUID();
    const allocation = await k.execute('CollectionAllocation.allocate', input, { ...env.system(), requestId });
    const [row] = await env.query('update sys.outbox set status=$1,locked_at=now() where aggregate_id=$2 and event=$3 returning *', ['processing', allocation.id, Requested.name]);
    expect(await deliver(k, { ...row, id: Number(row.id) } as OutboxRow, worker.consumers)).toBe('done');
    const commands = await env.query('select command from sys.audit_log where request_id=$1 and result=$2 order by id', [requestId, 'ok']);
    expect(commands.map((entry) => entry.command)).toEqual(['CollectionAllocation.allocate', 'CollectionBudget.freeze', 'CollectionAsset.reserve', 'CollectionAsset.reserve', 'CollectionLine.addLine', 'CollectionTicket.issue']);
    const implicit = createKernel({ db: { app: env.kernel.app, read: env.kernel.readDb }, logger: silentLogger, domain: { ...domain,
      zFirst: reaction(Requested, { command: issue, map: () => null }),
      aSecond: reaction(Requested, { command: issue, map: () => null }),
    } });
    expect(reactionConsumers(implicit).filter((consumer) => consumer.event === Requested.name).map((consumer) => consumer.name)).toEqual(['reaction:zFirst', 'reaction:aSecond']);
  });
});
