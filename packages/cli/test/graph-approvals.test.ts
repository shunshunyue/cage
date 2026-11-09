/**
 * 验证审批声明到流程子图及容器布局的投影。
 * 由真实注册表抽取步骤、选人、条件组和结论，核对跳过整组路径、长文测量及审批容器参与主图排布。
 * 审批可见结构只表达声明，测试不选取真实审批人或执行审批任务。
 */
import { expect, it } from 'vitest';
import {
  aggregate,
  approval,
  bool,
  buildRegistry,
  command,
  event,
  id,
  money,
  states,
  text,
} from '@yss123/cage-kernel';
import { approver, branch, eq, gt, gte, isIn, ne, parallel, route, step, when } from '../../approval/src/route.js';
import { approvalOperations } from '../../approval/src/operations.js';
import { extract } from '../src/ontology.js';
import { projectGraph, type ViewNode } from '../src/graph-model.js';
import { approvalFlowForStep, isApprovalRejection } from '../src/graph-approvals.js';
import { traceBusinessFlow, flattenBusinessSteps, type BusinessStep } from '../src/graph-business.js';
import { layoutApprovalFlow } from '../ui/approval-flow.js';
import { flowEdgeGeometry, layoutBusinessFlow } from '../ui/flowchart.js';
import { explainEdge } from '../src/graph-relations.js';

const Request = aggregate('Request', {
  fields: { amount: money(), highRisk: bool(), deptId: text(), requesterId: id() },
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
  routable: ['amount', 'highRisk', 'deptId', 'requesterId'],
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
/**
 * 把指定展示节点放入独立步骤，复用已抽取审批的基础结构但清空子链和中间证据。
 * 用来比较阶段主实现与仅用于 details 的引用，不改变原始 reviewStep。
 */
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

/** 字段选人与候选共享任务必须保留到图谱，不能被误标为部门负责人或逐人会签。 */
it('显示单据字段候选和前后必签规则，字段依赖仍可追踪', () => {
  const fieldRoute = route('request-review', [step('字段复核', approver.field('deptId'), { assignment: 'candidate', actions: { addSign: true } })]);
  const fieldModel = projectGraph(extract(buildRegistry({ ...domain, reviewRoute: fieldRoute })));
  const fieldFlow = approvalFlowForStep(fieldModel, reviewStep, labels)!;
  expect(fieldFlow.groups[0].tasks[0].actor).toBe('申请部门指定的审批人');
  expect(fieldFlow.groups[0].tasks[0].rule).toContain('候选共享一项任务');
  expect(fieldFlow.groups[0].tasks[0].rule).toContain('前签、后签和并行加签');
  expect(fieldRoute.fieldsUsed).toEqual(['deptId']);
});

/** 真声明经过注册→抽取→投影→布局，验证并行分支没有被当成顺序叶节点或漏掉嵌套字段依赖。 */
it('AND并行保留独立分支与嵌套条件，分叉和汇合位于全部分支两端', () => {
  const concurrent = route('request-review', [
    step('进入会审前', approver.role('finance')),
    parallel('跨部门联合核查',
      branch('业务核查', step('业务初核', approver.deptLeader('deptId')), step('业务复核', approver.role('supervisor'))),
      branch('专业核查', when(gt('amount', 5000), parallel('专项并审',
        branch('技术意见', step('技术评估', approver.field('requesterId'))),
        branch('合规意见', when(eq('highRisk', true), step('风险核查', approver.role('finance')))),
      ))),
    ),
    step('汇合后确认', approver.role('finance')),
  ]);
  const registry = buildRegistry({ ...domain, reviewRoute: concurrent }), graph = extract(registry), projected = projectGraph(graph);
  const flow = approvalFlowForStep(projected, reviewStep, labels)!;
  expect(flow.groups[1].tasks).toEqual([]);
  expect(flow.groups[1].parallel?.branches.map(item => item.title)).toEqual(['业务核查', '专业核查']);
  expect(flow.groups[1].parallel?.branches[1].groups[0].groups?.[0].parallel?.title).toBe('专项并审');
  for (const field of ['deptId', 'requesterId', 'amount', 'highRisk']) {
    const edge = projected.edges.find(item => item.from === flow.route!.key && item.to === `field:Request.${field}`)!;
    expect(edge).toBeDefined();
    const description = explainEdge(edge, projected, labels);
    expect(description.why).not.toBe('。'); expect(description.evidence.length).toBeGreaterThan(0);
  }
  const layout = layoutApprovalFlow(flow, '包含长标题和嵌套 AND 的真实声明图');
  expect(layout.boxes.filter(box => box.kind === 'fork')).toHaveLength(2);
  expect(layout.boxes.filter(box => box.kind === 'join')).toHaveLength(2);
  const box = (title: string) => layout.boxes.find(item => item.task?.title === title)!;
  expect(box('业务初核').x).toBeLessThan(box('技术评估').x);
  expect(box('业务复核').y).toBeGreaterThan(box('业务初核').y + box('业务初核').height);
  const outerJoin = layout.boxes.filter(item => item.kind === 'join').sort((a, b) => b.y - a.y)[0];
  for (const title of ['业务复核', '技术评估', '风险核查']) expect(box(title).y + box(title).height).toBeLessThan(outerJoin.y);
  expect(box('汇合后确认').y).toBeGreaterThan(outerJoin.y + outerJoin.height);
  expect(layout.paths.filter(path => path.skip)).toHaveLength(2);
  for (const item of layout.boxes) {
    expect(item.x).toBeGreaterThanOrEqual(0); expect(item.x + item.width).toBeLessThanOrEqual(layout.width);
    expect(item.y + item.height).toBeLessThan(layout.footer);
  }
  for (const a of layout.boxes) for (const b of layout.boxes) {
    if (a === b) continue;
    expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
  }
});

/** 条件包裹并行时，“否”旁路应绕过全部分支及其 AND 汇合，不能接到其中一个分支内部。 */
it('条件包裹AND组时跳过线在整个并行块之后汇合', () => {
  const conditional = route('request-review', [when(eq('highRisk', true), parallel('联合审查',
    branch('第一分支', step('第一审核', approver.role('finance'))),
    branch('第二分支', step('第二审核', approver.role('supervisor'))))), step('最终确认', approver.role('finance'))]);
  const projected = projectGraph(extract(buildRegistry({ ...domain, reviewRoute: conditional })));
  const flow = approvalFlowForStep(projected, reviewStep, labels)!, layout = layoutApprovalFlow(flow, '条件会审');
  const gateway = layout.boxes.find(box => box.kind === 'join')!, skip = layout.paths.find(path => path.skip)!;
  expect(skip.d).toContain(`V${layout.merges[0].y}`);
  expect(layout.merges[0].y).toBeGreaterThan(gateway.y + gateway.height);
  expect(layout.merges[0].y).toBeLessThan(layout.boxes.find(box => box.task?.title === '最终确认')!.y);
  const container = layoutBusinessFlow(root, item => item.node.id, () => '', 'lr', new Map([[reviewStep.id, flow]]));
  expect(container.nodes.find(node => node.step.id === reviewStep.id)?.approval?.width).toBe(layout.width);
});

/** SLA 和申请人依赖必须出现在声明图中，不能把时限画成自动批准或把申请人误标为审批人。 */
it('保留自然分钟节点时限和催办申请人关系，提醒不等同自动结论', () => {
  const timedRoute = route('request-review', [step('限时核查', approver.role('reviewer'), {
    sla: { durationMinutes: 30, remindBeforeMinutes: 5 },
  })], { reminders: { requesterField: 'requesterId', cooldownMinutes: 10 } });
  const timedModel = projectGraph(extract(buildRegistry({ ...domain, reviewRoute: timedRoute, approvalOps: approvalOperations() })));
  const timedFlow = approvalFlowForStep(timedModel, reviewStep, labels)!;
  expect(timedFlow.groups[0].tasks[0].rule).toContain('节点总时限 30 自然分钟');
  expect(timedFlow.groups[0].tasks[0].rule).toContain('超时仅提醒');
  expect(timedFlow.route?.attrs.reminders).toEqual({ requesterField: 'requesterId', cooldownMinutes: 10 });
  expect(timedModel.edges.some(edge => edge.from === timedFlow.route!.key && edge.to === 'field:Request.requesterId' && edge.as === '催办申请人')).toBe(true);
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

/** 新政策必须从真实抽取链进入图说明，不能把含必签的 any 节点展示成任意一票即可完成。 */
it('审批阅读图说明并行必签与委派归还边界', () => {
  const managedRoute = route('request-review', [step('协作审核', approver.role('finance'), {
    mode: 'any', actions: { transfer: true, delegate: true, addSign: true },
  })]);
  const next = projectGraph(extract(buildRegistry({ ...domain, reviewRoute: managedRoute })));
  const task = approvalFlowForStep(next, reviewStep, labels)!.groups[0].tasks[0];
  expect(task.rule).toContain('全部加签人同意');
  expect(task.rule).toContain('归还后由原负责人决定');
  expect(task.rule).toContain('允许转办');
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
