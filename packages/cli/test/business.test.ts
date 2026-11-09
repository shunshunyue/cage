/**
 * 验证原始本体到业务板块及触发链的纯投影。
 * 人工构造节点和边以隔离归属、审批结论、同事务/异步语义，以及循环、深度和重复调用路径身份。
 * 断言读取边不会伪装成后续执行；本套件不加载领域源码或启动服务。
 */
import { expect, it } from 'vitest';
import { projectGraph } from '../src/graph-model.js';
import { businessBlocks, traceBusinessFlow, flattenBusinessSteps } from '../src/graph-business.js';
import type { Ontology, OntNode } from '../src/ontology.js';

/**
 * 构造原始本体节点，attrs 承载当前用例需要的元数据；有 file 时统一指向第 1 行。
 * 空 hash 表示测试不验证语义变更，只隔离投影关系和路径身份。
 */
const node = (
  kind: OntNode['kind'],
  id: string,
  attrs: Record<string, unknown> = {},
  file?: string,
): OntNode => ({ kind, id, hash: '', attrs, ...(file ? { file, line: 1 } : {}) });
const graph: Ontology = {
  version: 1,
  unsafeCount: 0,
  nodes: [
    node('aggregate', 'Order', {}, 'packages/domain/src/modules/purchase/order.ts'),
    node('aggregate', 'Stock', {}, 'packages/domain/src/modules/inventory/stock.ts'),
    node('aggregate', 'Lock', {}, 'packages/domain/src/modules/inventory/stock.ts'),
    node('aggregate', 'User'),
    node('aggregate', 'Legacy', {}, 'domain/legacy.ts'),
    node('command', 'Order.submit', { from: ['draft'], to: 'pending', invokedBy: ['user'] }),
    node('command', 'Order.approve', { from: ['pending'], to: 'approved' }),
    node('command', 'Order.reject'),
    node('command', 'Order.cancel'),
    node('command', 'Lock.acquire'),
    node('command', 'Lock.release'),
    node('command', 'Stock.create'),
    node('command', 'User.create'),
    node('query', 'report'),
    node('job', 'expire'),
    node('inbound', 'callback'),
    node('event', 'Submitted'),
    node('event', 'Approved'),
    node('event', 'Cancelled'),
    node('approval', 'approval', {
      aggregate: 'Order',
      onApproved: 'Order.approve',
      onRejected: 'Order.reject',
    }),
    node('reaction', 'acquire', { tx: 'same' }),
    node('reaction', 'release', { tx: 'outbox' }),
  ],
  edges: [
    { kind: 'emits', from: 'Order.submit', to: 'Submitted' },
    { kind: 'triggers', from: 'Submitted', to: 'approval' },
    { kind: 'binds', from: 'approval', to: 'Order.approve' },
    { kind: 'binds', from: 'approval', to: 'Order.reject' },
    { kind: 'emits', from: 'Order.approve', to: 'Approved' },
    { kind: 'triggers', from: 'Approved', to: 'acquire' },
    { kind: 'targets', from: 'acquire', to: 'Lock.acquire' },
    { kind: 'reads', from: 'Order.approve', to: 'Stock' },
    { kind: 'emits', from: 'Order.cancel', to: 'Cancelled' },
    { kind: 'cancels', from: 'Cancelled', to: 'approval' },
    { kind: 'triggers', from: 'Cancelled', to: 'release' },
    { kind: 'targets', from: 'release', to: 'Lock.release' },
    { kind: 'queries', from: 'report', to: 'Order' },
    { kind: 'queries', from: 'report', to: 'Stock' },
    { kind: 'calls', from: 'expire', to: 'Order.cancel' },
    { kind: 'targets', from: 'callback', to: 'Order.approve' },
  ],
};
const model = projectGraph(graph);

it('首页按业务模块收纳对象，跨模块报表可在两处找到，系统对象默认不出现', () => {
  const before = JSON.stringify(model);
  const blocks = businessBlocks(model, { 'aggregate:Order': '采购单', 'aggregate:Stock': '库存' });
  expect(blocks.find((b) => b.id === 'module:inventory')!.objects.map((n) => n.id)).toEqual(
    expect.arrayContaining(['Stock', 'Lock']),
  );
  const purchase = blocks.find((b) => b.id === 'module:purchase')!;
  expect(purchase.title).toBe('采购单');
  expect(purchase.flows.map((n) => n.id)).toEqual(
    expect.arrayContaining(['Order.submit', 'report', 'expire', 'callback']),
  );
  expect(blocks.filter((b) => b.flows.some((n) => n.id === 'report'))).toHaveLength(2);
  expect(blocks.some((b) => b.objects.some((n) => n.id === 'Legacy'))).toBe(true);
  expect(blocks.some((b) => b.objects.some((n) => n.id === 'User'))).toBe(false);
  expect(
    businessBlocks(model, {}, true)
      .find((b) => b.system)!
      .flows.map((n) => n.id),
  ).toContain('User.create');
  expect(JSON.stringify(model)).toBe(before);
  expect(
    businessBlocks(model, { 'module:purchase': '采购管理' }).find((b) => b.id === 'module:purchase')!.title,
  ).toBe('采购管理');
});

it('提交链保留审批结论与事务语义，不把读取库存或同对象的取消操作画成后续执行', () => {
  const root = traceBusinessFlow(model, 'command:Order.submit')!;
  const steps = flattenBusinessSteps(root);
  expect(steps.map((s) => s.node.id)).toEqual([
    'Order.submit',
    'approval',
    'Order.approve',
    'Lock.acquire',
    'Order.reject',
  ]);
  const acquired = steps.find((s) => s.node.id === 'Lock.acquire')!;
  expect(acquired.label).toContain('同一事务');
  expect(acquired.via.map((n) => n.id)).toEqual(['Approved', 'acquire']);
  expect(acquired.note).toContain('返回 null 时跳过');
  expect(steps.find((s) => s.node.id === 'Order.reject')!.label).toBe('审批驳回时');
});

it('取消审批是终止分支，不会从取消动作继续画出审批通过；释放保留异步与条件说明', () => {
  const root = traceBusinessFlow(model, 'command:Order.cancel')!;
  expect(root.children.find((s) => s.node.kind === 'approval')!.children).toEqual([]);
  const release = root.children.find((s) => s.node.id === 'Lock.release')!;
  expect(release.label).toContain('异步');
  expect(release.note).toContain('映射函数');
  expect(flattenBusinessSteps(root).some((s) => s.node.id === 'Order.approve')).toBe(false);
});

it('任务调用只表示声明可调用；循环和深度边界明确标记，查询不沿读依赖扩散', () => {
  expect(traceBusinessFlow(model, 'job:expire')!.children[0].label).toBe('任务声明可调用');
  expect(traceBusinessFlow(model, 'query:report')!.children).toEqual([]);
  expect(traceBusinessFlow(model, 'command:Order.submit', 0)!.boundary).toBe(true);
  const cyclic = structuredClone(model);
  cyclic.edges.push({
    key: 'cycle',
    kind: 'emits',
    derived: false,
    from: 'command:Lock.acquire',
    to: 'event:Submitted',
  });
  const steps = flattenBusinessSteps(traceBusinessFlow(cyclic, 'command:Order.submit')!);
  expect(steps.some((s) => s.node.id === 'approval' && s.repeated && !s.children.length)).toBe(true);
  expect(traceBusinessFlow(model, 'command:missing')).toBeUndefined();
});

it('同一目标被不同事件映射调用时，后续步骤仍保留各自路径身份', () => {
  const input = structuredClone(graph);
  for (const id of ['first', 'second']) {
    input.nodes.push(node('reaction', id, { tx: 'same' }));
    input.edges.push(
      { kind: 'triggers', from: 'Submitted', to: id },
      { kind: 'targets', from: id, to: 'Order.approve' },
    );
  }
  const steps = flattenBusinessSteps(traceBusinessFlow(projectGraph(input), 'command:Order.submit')!).filter(
    (s) => s.node.id === 'Lock.acquire',
  );
  expect(steps).toHaveLength(3);
  expect(new Set(steps.map((s) => s.id)).size).toBe(3);
});
