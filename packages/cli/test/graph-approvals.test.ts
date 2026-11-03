import { expect, it } from 'vitest';
import {
  aggregate,
  approval,
  bool,
  buildRegistry,
  command,
  event,
  money,
  states,
  text,
} from '@yss123/cage-kernel';
import { approver, eq, gt, gte, isIn, ne, route, step, when } from '../../approval/src/route.js';
import { extract } from '../src/ontology.js';
import { projectGraph, type ViewNode } from '../src/graph-model.js';
import { approvalFlowForStep, isApprovalRejection } from '../src/graph-approvals.js';
import { traceBusinessFlow, flattenBusinessSteps, type BusinessStep } from '../src/graph-business.js';
import { layoutApprovalFlow } from '../ui/approval-flow.js';
import { flowEdgeGeometry, layoutBusinessFlow } from '../ui/flowchart.js';

const Request = aggregate('Request', {
  fields: { amount: money(), highRisk: bool(), deptId: text() },
  states: states('pending', 'approved', 'rejected'),
});
const Submitted = event('Submitted', {});
const submit = command(Request, { from: 'new', to: 'pending', emits: [Submitted], handler: () => ({}) });
const approve = command(Request, {
  from: 'pending',
  to: 'approved',
  invokedBy: 'process',
  handler: () => ({}),
});
const reject = command(Request, {
  from: 'pending',
  to: 'rejected',
  invokedBy: 'process',
  handler: () => ({}),
});
const review = approval(Request, {
  process: 'request-review',
  start: Submitted,
  routable: ['amount', 'highRisk', 'deptId'],
  onApproved: approve,
  onRejected: reject,
});
const reviewRoute = route('request-review', [
  step('部门审批', approver.deptLeader('deptId')),
  when(eq('highRisk', true), step('设备审批', approver.role('supervisor'), { mode: 'all' })),
  when(gt('amount', 5000), step('财务审批', approver.role('finance'))),
]);
const domain = { Request, Submitted, submit, approve, reject, review, reviewRoute };
const model = projectGraph(extract(buildRegistry(domain)));
const labels = {
  'field:Request.deptId': '申请部门',
  'field:Request.highRisk': '包含高风险设备',
  'field:Request.amount': '预估费用',
  'role:supervisor': '设备主管',
  'role:finance': '财务',
};
const root = traceBusinessFlow(model, 'command:Request.submit')!;
const reviewStep = flattenBusinessSteps(root).find((s) => s.node.kind === 'approval')!;
const flow = approvalFlowForStep(model, reviewStep, labels)!;
const asStep = (node: ViewNode): BusinessStep => ({
  ...reviewStep,
  id: node.key,
  node,
  children: [],
  via: [],
});

it('从真实注册与抽取链展开审批顺序、条件、审批人及任一/全部同意规则', () => {
  const before = JSON.stringify(model);
  expect(flow.route?.key).toBe('route:route:request-review');
  expect(flow.groups.map((g) => g.condition)).toEqual([undefined, '包含高风险设备', '预估费用大于5,000']);
  expect(flow.groups.flatMap((g) => g.tasks)).toEqual([
    { number: 1, title: '部门审批', actor: '申请部门的负责人', rule: '任一审批人同意即可继续', mode: 'any' },
    { number: 2, title: '设备审批', actor: '设备主管', rule: '所有审批人同意后继续', mode: 'all' },
    { number: 3, title: '财务审批', actor: '财务', rule: '任一审批人同意即可继续', mode: 'any' },
  ]);
  expect(JSON.stringify(model)).toBe(before);
});

it('阶段只展开主要审批，取消及仅作为 details 证据引用时不会被画成执行审批', () => {
  const stage: ViewNode = {
    kind: 'stage',
    id: 'overview.review',
    key: 'stage:overview.review',
    hash: '',
    attrs: { primary: 'approval:review' },
  };
  expect(approvalFlowForStep(model, asStep(stage), labels)?.groups).toEqual(flow.groups);
  expect(approvalFlowForStep(model, { ...reviewStep, label: '取消审批' }, labels)).toBeUndefined();
  expect(
    approvalFlowForStep(
      model,
      { ...asStep({ ...stage, attrs: { primary: 'command:Request.submit' } }), via: [reviewStep.node] },
      labels,
    ),
  ).toBeUndefined();
  const missing = { ...model, edges: model.edges.filter((e) => e.from !== flow.route!.key) };
  expect(approvalFlowForStep(missing, reviewStep, labels)).toMatchObject({ groups: [] });
  expect(approvalFlowForStep(missing, reviewStep, labels)?.route).toBeUndefined();
});

it('条件边界保留大于等于、布尔否、集合值，指定用户使用真实 userId', () => {
  const more = route('request-review', [
    when(gte('amount', 5000), step('复核', approver.user('reviewer-17'))),
    when(eq('highRisk', false), step('普通设备', approver.role('finance'))),
    when(ne('highRisk', true), step('非高风险', approver.role('finance'))),
    when(isIn('deptId', ['sales', 'support']), step('指定部门', approver.role('finance'))),
  ]);
  const next = projectGraph(extract(buildRegistry({ ...domain, reviewRoute: more })));
  const result = approvalFlowForStep(next, reviewStep, labels)!;
  expect(result.groups.map((g) => g.condition)).toEqual([
    '预估费用大于等于5,000',
    '包含高风险设备为否',
    '包含高风险设备不为是',
    '申请部门属于sales、support',
  ]);
  expect(result.groups[0].tasks[0].actor).toBe('指定用户 reviewer-17');
});

it('多步骤条件组的跳过路径绕开整组，长文字完整测量且不越出容器', () => {
  const expanded = {
    ...flow,
    groups: [
      {
        condition: '预估费用大于等于5,000并且必须经过指定部门的联合审批',
        tasks: [
          flow.groups[0].tasks[0],
          { ...flow.groups[1].tasks[0], title: '需要所有设备主管一起完成的长标题审批步骤' },
        ],
      },
      flow.groups[2],
    ],
  };
  const layout = layoutApprovalFlow(expanded, '设备租赁联合审批');
  expect(layout.boxes.map((b) => b.kind)).toEqual(['condition', 'task', 'task', 'condition', 'task']);
  expect(layout.paths.filter((p) => p.skip)).toHaveLength(2);
  const secondTask = layout.boxes[2];
  expect(layout.merges[0].y).toBeGreaterThan(secondTask.y + secondTask.height);
  expect(layout.merges[0].y).toBeLessThan(layout.boxes[3].y);
  expect(layout.boxes[2].title.join('')).toBe(expanded.groups[0].tasks[1].title);
  for (const box of layout.boxes) {
    expect(box.y + box.height).toBeLessThan(layout.footer);
    expect(box.x + box.width).toBeLessThan(layout.width);
  }
});

it('展开的审批容器参与横纵布局，业务结论仍连向原步骤且不穿过其他节点', () => {
  const approvals = new Map([[reviewStep.id, flow]]);
  for (const direction of ['tb', 'lr'] as const) {
    const layout = layoutBusinessFlow(
      root,
      (s) => s.node.id,
      () => '',
      direction,
      approvals,
    );
    const approval = layout.nodes.find((n) => n.step.id === reviewStep.id)!;
    expect(approval.approval?.boxes.filter((b) => b.kind === 'task')).toHaveLength(3);
    expect(approval.decision).toBe(false);
    for (const a of layout.nodes)
      for (const b of layout.nodes) {
        if (a === b) continue;
        const p = a.position,
          q = b.position;
        expect(
          p.x < q.x + q.width && p.x + p.width > q.x && p.y < q.y + q.height && p.y + p.height > q.y,
        ).toBe(false);
      }
    const obstacles = layout.nodes.map((n) => n.position);
    for (const edge of layout.edges) {
      const from = layout.nodes.find((n) => n.step.id === edge.from)!.position;
      const to = layout.nodes.find((n) => n.step.id === edge.to)!.position;
      const geometry = flowEdgeGeometry(from, to, direction, edge.loop, obstacles, edge.routing);
      expect(geometry.points[0]).toEqual(
        edge.routing
          ? direction === 'tb'
            ? { x: from.x, y: from.y + from.height * edge.routing.sourcePort }
            : { x: from.x + from.width * edge.routing.sourcePort, y: from.y }
          : direction === 'tb'
            ? { x: from.x + from.width / 2, y: from.y + from.height }
            : { x: from.x + from.width, y: from.y + from.height / 2 },
      );
    }
  }
  const rejected = reviewStep.children.find((s) => s.node.id === 'Request.reject')!;
  expect(isApprovalRejection(flow, { ...rejected, label: '结束当前申请' })).toBe(true);
  expect(
    isApprovalRejection(
      flow,
      reviewStep.children.find((s) => s.node.id === 'Request.approve')!,
    ),
  ).toBe(false);
});
