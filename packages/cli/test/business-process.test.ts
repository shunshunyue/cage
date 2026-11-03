import { expect, it } from 'vitest';
import { aggregate, approval, buildRegistry, businessProcess, command, event, reaction, states, text } from '@yss123/cage-kernel';
import { schemaModel } from '@yss123/cage-kernel/db';
import { extract, diffOntology } from '../src/ontology.js';
import { projectGraph } from '../src/graph-model.js';
import { businessBlocks, businessJourneys, flattenBusinessSteps, traceBusinessLifecycle, traceBusinessProcess, businessLabel } from '../src/graph-business.js';
import { checkBusinessProcesses } from '../src/process-rules.js';
import { graphPresentation } from '../src/graph-presentation.js';
import { layoutBusinessFlow } from '../ui/flowchart.js';
import { impact } from '../src/impact.js';
import type { CageConfig } from '../src/config.js';

const Request = aggregate('Request', { description: '申请单', fields: { title: text() },
  states: states('draft', 'pending', 'approved', 'rejected', 'closed', 'cancelled', {
    terminal: ['closed', 'cancelled'], labels: { draft: '草稿', pending: '审批中' },
  }) });
const Stock = aggregate('Stock', { description: '库存占用', fields: {} });
const Submitted = event('Submitted', {}), Approved = event('Approved', {});
const create = command(Request, { from: 'new', to: 'draft', handler: () => ({}) });
const submit = command(Request, { from: 'draft', to: 'pending', emits: [Submitted], handler: () => ({}) });
const approve = command(Request, { from: 'pending', to: 'approved', invokedBy: 'process', reads: { stock: Stock }, emits: [Approved], handler: () => ({}) });
const reject = command(Request, { from: 'pending', to: 'rejected', invokedBy: 'process', handler: () => ({}) });
const edit = command(Request, { from: 'rejected', to: 'draft', handler: () => ({}) });
const finish = command(Request, { from: 'approved', to: 'closed', handler: () => ({}) });
const cancel = command(Request, { from: ['draft', 'pending'], to: 'cancelled', handler: () => ({}) });
const acquire = command(Stock, { from: 'new', to: 'active', invokedBy: 'process', handler: () => ({}) });
const acquireOnApprove = reaction(Approved, { command: acquire, map: () => ({}), tx: 'same' });
const review = approval(Request, { process: 'request-review', start: Submitted, routable: [], onApproved: approve, onRejected: reject });
const domain = { Request, Stock, Submitted, Approved, create, submit, approve, reject, edit, finish, cancel, acquire, acquireOnApprove, review };
const definition = {
  title: '申请全流程', description: '提交、审批、修改与结束。', subject: Request,
  area: { id: 'requests', title: '申请管理', description: '管理申请全流程。' }, entry: 'create',
  stages: {
    create: { title: '填写申请', description: '建立草稿。', action: create },
    submit: { title: '提交申请', description: '提交当前草稿。', action: submit },
    review: { title: '审批', description: '等待审批结论。', kind: 'decision', action: review },
    approved: { title: '批准并锁库存', description: '通过后同事务占用。', action: approve,
      related: [{ object: Stock, label: '锁定库存', via: acquire }] },
    rejected: { title: '驳回', description: '可修改后重提。', action: reject },
    edit: { title: '修改申请', description: '回到草稿后重提。', action: edit },
    finish: { title: '完成', description: '结束申请。', kind: 'end', action: finish },
    cancel: { title: '取消', description: '结束申请。', kind: 'end', action: cancel },
  },
  transitions: [
    { from: 'create', to: 'submit', mode: 'manual', label: '填写后提交' },
    { from: 'submit', to: 'review', mode: 'automatic', label: '启动审批' },
    { from: 'review', to: 'approved', mode: 'automatic', label: '通过' },
    { from: 'review', to: 'rejected', mode: 'automatic', label: '驳回' },
    { from: 'rejected', to: 'edit', mode: 'manual', label: '修改' },
    { from: 'edit', to: 'submit', mode: 'manual', label: '重新提交' },
    { from: 'approved', to: 'finish', mode: 'manual', label: '确认完成' },
    { from: 'create', to: 'cancel', mode: 'manual', label: '取消', branch: true },
  ],
} satisfies Parameters<typeof businessProcess>[1];
const flow = businessProcess('request-flow', definition);
const registry = buildRegistry({ ...domain, flow });
const graph = extract(registry), model = projectGraph(graph);

it('流程引用被注册和抽取，保持执行能力、数据库结构和消费者不变', () => {
  const base = buildRegistry(domain);
  expect(registry.businessProcesses).toEqual([flow]);
  expect(registry.capabilityCatalog()).toEqual(base.capabilityCatalog());
  expect(schemaModel(registry)).toEqual(schemaModel(base));
  expect(registry.consumerProviders()).toEqual(base.consumerProviders());
  expect(checkBusinessProcesses(graph)).toEqual([]);
  expect(graph.nodes.filter(n => n.kind === 'stage')).toHaveLength(8);
  const block = businessBlocks(model).find(b => b.id === 'module:requests')!;
  expect(block.title).toBe('申请管理');
  expect(businessJourneys(block, model).map(n => n.id)).toEqual(['request-flow']);
});

it('删除真实触发关系后自动连线和业务关联失效，读取依赖不能证明自动执行', () => {
  const stale = structuredClone(graph);
  stale.edges = stale.edges.filter(e => !(e.kind === 'emits' && e.from === 'Request.submit'));
  expect(checkBusinessProcesses(stale).some(f => f.reason.includes('没有实际触发链'))).toBe(true);
  const missingResource = structuredClone(graph);
  missingResource.edges = missingResource.edges.filter(e => !(e.kind === 'targets' && e.to === 'Stock.acquire'));
  expect(checkBusinessProcesses(missingResource).some(f => f.reason.includes('缺少对应实现关系'))).toBe(true);
  const invented = extract(buildRegistry({ ...domain, flow: businessProcess('bad-auto', {
    ...definition, transitions: definition.transitions.map(e => e.from === 'create' ? { ...e, mode: 'automatic' } : e),
  }) }));
  expect(checkBusinessProcesses(invented).filter(f => f.reason.includes('没有实际触发链'))).toHaveLength(2);
});

it('人工、等待、状态可达性及结束结果分别检查，不能把内部结论当用户操作', () => {
  const invalid = structuredClone(graph);
  invalid.edges.find(e => e.kind === 'follows' && e.to === 'request-flow.approved')!.mode = 'manual';
  invalid.edges.find(e => e.kind === 'follows' && e.to === 'request-flow.finish')!.mode = 'wait';
  invalid.edges = invalid.edges.filter(e => !(e.kind === 'follows' && e.to === 'request-flow.edit'));
  const reasons = checkBusinessProcesses(invalid).map(f => f.reason).join('\n');
  expect(reasons).toContain('不是用户可调用命令');
  expect(reasons).toContain('没有外部通知或调度入口');
  expect(reasons).toContain('从入口不可达');
  expect(reasons).toContain('无法到达结束结果');
  const mismatch = structuredClone(graph);
  mismatch.edges.find(e => e.kind === 'follows' && e.from === 'request-flow.create' && !e.branch)!.to = 'request-flow.finish';
  expect(checkBusinessProcesses(mismatch).some(f => f.reason.includes('状态不相接'))).toBe(true);
});

it('未导出引用、重复流程、板块冲突和无效阶段在声明或注册时明确报错', () => {
  expect(() => buildRegistry({ Request, flow })).toThrow(/CAGE-BIZ-001/);
  expect(() => buildRegistry({ ...domain, flow, duplicate: businessProcess('request-flow', definition) })).toThrow(/重复/);
  expect(() => buildRegistry({ ...domain, flow, another: businessProcess('other-flow', { ...definition, area: { ...definition.area, title: '其他名称' } }) })).toThrow(/不一致/);
  expect(() => businessProcess('bad-flow', { ...definition, entry: 'missing' })).toThrow(/入口阶段不存在/);
  expect(() => businessProcess('bad-flow', { ...definition, title: ' ' })).toThrow(/名称和说明/);
  expect(() => businessProcess('bad-flow', { ...definition, transitions: [...definition.transitions, { from: 'finish', to: 'submit', mode: 'manual', label: '继续' }] })).toThrow(/结束阶段/);
});

it('主线、次要分支和对象关联可独立展开，循环和汇合只保留一份阶段', () => {
  const process = model.nodes.find(n => n.kind === 'process')!;
  const main = traceBusinessProcess(model, process, { branches: false, related: false });
  expect(flattenBusinessSteps(main).some(s => s.node.id.endsWith('.cancel'))).toBe(false);
  expect(flattenBusinessSteps(main).some(s => s.mode === 'association')).toBe(false);
  const expanded = traceBusinessProcess(model, process, { branches: true, related: true });
  const layout = layoutBusinessFlow(expanded, s => businessLabel(s.node), s => s.mode === 'association' ? s.label : '');
  expect(layout.nodes.filter(n => n.step.node.kind === 'stage')).toHaveLength(8);
  expect(new Set(layout.nodes.map(n => n.step.id)).size).toBe(layout.nodes.length);
  expect(layout.edges.some(e => e.loop && e.to === 'stage:request-flow.submit')).toBe(true);
  expect(layout.nodes.some(n => n.association && n.step.node.id === 'Stock')).toBe(true);
});

it('同层关联和流程分支在两种方向均无节点重叠，汇合连线指向已有阶段', () => {
  const p = model.nodes.find(n => n.kind === 'process')!;
  const modified = structuredClone(model);
  modified.edges.push({ key: 'merge', kind: 'follows', from: 'stage:request-flow.edit', to: 'stage:request-flow.finish', mode: 'manual', label: '条件满足后结束', derived: false });
  for (const direction of ['tb', 'lr'] as const) {
    const root = traceBusinessProcess(modified, p, { branches: true, related: true });
    const layout = layoutBusinessFlow(root, s => businessLabel(s.node), () => '', direction);
    expect(layout.edges.filter(e => e.to === 'stage:request-flow.finish')).toHaveLength(2);
    for (const a of layout.nodes) for (const b of layout.nodes) {
      if (a === b) continue;
      const x = a.position, y = b.position;
      expect(x.x < y.x + y.width && x.x + x.width > y.x && x.y < y.y + y.height && x.y + x.height > y.y).toBe(false);
    }
  }
});

it('旧项目的状态图保持真实命令依据，状态中文名可随声明维护且不影响业务标识', () => {
  const base = buildRegistry(domain), graph = extract(base), view = projectGraph(graph);
  const presentation = graphPresentation({ name: 'test' } as CageConfig, base);
  expect(presentation.labels['state:Request.draft']).toBe('草稿');
  const root = traceBusinessLifecycle(view, view.nodes.find(n => n.kind === 'aggregate' && n.id === 'Request')!, presentation.labels);
  const steps = flattenBusinessSteps(root);
  expect(steps.some(s => s.via[0]?.key === 'command:Request.submit')).toBe(true);
  expect(steps.every(s => s.mode === 'lifecycle')).toBe(true);
  expect(businessLabel(view.nodes.find(n => n.key === 'command:Request.submit')!)).toBe('待命名操作');
  expect(() => states('active', { labels: { missing: '无效' } } as never)).toThrow(/CAGE-STATE-005/);
});

it('实现改变会影响引用它的阶段和流程，规格修改不会扩散为业务命令被修改', () => {
  const changed = structuredClone(graph);
  changed.nodes.find(n => n.kind === 'command' && n.id === 'Request.approve')!.hash = 'changed';
  const affected = impact(graph, changed, []).affected;
  expect(affected).toContain('request-flow.approved');
  expect(affected).toContain('request-flow');
  const renamed = businessProcess('request-flow', { ...definition, transitions: definition.transitions.map(e => ({ ...e, label: `${e.label}。` })) });
  const next = extract(buildRegistry({ ...domain, flow: renamed }));
  expect(diffOntology(graph, next).changed.map(c => c.after.kind)).toEqual(['process']);
  expect(impact(graph, next, []).affected).not.toContain('Request.approve');
});
