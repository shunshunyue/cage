import type { BusinessStep } from './graph-business.js';
import type { GraphModel, ViewNode } from './graph-model.js';

// 审批路由已由抽取器保存为 JSON；阅读投影不引入审批引擎，也不求值业务条件。
interface RouteStep {
  kind: 'step';
  title: string;
  mode: 'any' | 'all';
  approver:
    { kind: 'deptLeader'; field: string } | { kind: 'role'; code: string } | { kind: 'user'; userId: string };
}
interface RouteCondition {
  field: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'in';
  value: string | number | boolean | (string | number)[];
}
interface AiRouteStep { kind: 'ai'; title: string; handoff: RouteStep['approver'] }
type RouteNode = RouteStep | AiRouteStep | { kind: 'when'; cond: RouteCondition; steps: (RouteStep | AiRouteStep)[] };

export interface ApprovalTask {
  number: number;
  title: string;
  actor: string;
  rule: string;
  mode: 'any' | 'all';
}
export interface ApprovalGroup {
  condition?: string;
  tasks: ApprovalTask[];
}
export interface ApprovalFlow {
  approval: ViewNode;
  route?: ViewNode;
  groups: ApprovalGroup[];
}

/** 只展开阶段的主要审批。details 中作为实现依据出现的审批不代表此处执行审批；
 * 取消动作也不能被画成重新走一轮审批。步骤顺序完全来自绑定的 route。 */
export function approvalFlowForStep(
  model: GraphModel,
  step: BusinessStep,
  labels: Record<string, string> = {},
): ApprovalFlow | undefined {
  if (step.label === '取消审批' || step.mode === 'association') return undefined;
  const approval =
    step.node.kind === 'approval'
      ? step.node
      : step.node.kind === 'stage'
        ? model.nodes.find((n) => n.kind === 'approval' && n.key === step.node.attrs.primary)
        : undefined;
  if (!approval) return undefined;
  const route = model.nodes.find(
    (n) =>
      n.kind === 'route' &&
      model.edges.some((e) => e.kind === 'binds' && e.from === n.key && e.to === approval.key),
  );
  if (!route) return { approval, groups: [] };
  const owner = String(approval.attrs.aggregate);
  const fieldName = (field: string) => labels[`field:${owner}.${field}`] ?? '待命名字段';
  const valueName = (value: string | number | boolean): string =>
    typeof value === 'number'
      ? value.toLocaleString('zh-CN', { maximumFractionDigits: 20 })
      : typeof value === 'boolean'
        ? value
          ? '是'
          : '否'
        : (labels[`state:${owner}.${value}`] ?? value);
  const conditionName = (condition: RouteCondition) => {
    const field = fieldName(condition.field);
    if (condition.op === 'eq' && condition.value === true) return field;
    const op = { gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', eq: '为', ne: '不为', in: '属于' };
    const value = Array.isArray(condition.value)
      ? condition.value.map(valueName).join('、')
      : valueName(condition.value);
    return `${field}${op[condition.op]}${value}`;
  };
  let number = 0;
  const task = (item: RouteStep | AiRouteStep): ApprovalTask => item.kind === 'ai' ? {
    number: ++number, title: item.title, actor: 'AI 审核', rule: '通过继续；退回修改结束本轮；转人工由本节点接管人处理', mode: 'any',
  } : ({
    number: ++number,
    title: item.title,
    actor:
      item.approver.kind === 'deptLeader'
        ? `${fieldName(item.approver.field)}的负责人`
        : item.approver.kind === 'role'
          ? (labels[`role:${item.approver.code}`] ?? '待命名审批角色')
          : `指定用户 ${item.approver.userId}`,
    rule: item.mode === 'all' ? '所有审批人同意后继续' : '任一审批人同意即可继续',
    mode: item.mode,
  });
  return {
    approval,
    route,
    groups: (route.attrs.nodes as RouteNode[]).map((item) =>
      item.kind !== 'when'
        ? { tasks: [task(item)] }
        : { condition: conditionName(item.cond), tasks: item.steps.map(task) },
    ),
  };
}

/** 从真实驳回结论绑定辨认出口，不依赖阶段标题里是否含有“驳回”二字。 */
export function isApprovalRejection(flow: ApprovalFlow, target: BusinessStep): boolean {
  const command =
    target.node.kind === 'command'
      ? target.node.key
      : target.node.kind === 'stage'
        ? target.node.attrs.primary
        : undefined;
  return command === `command:${flow.approval.attrs.onRejected}`;
}
