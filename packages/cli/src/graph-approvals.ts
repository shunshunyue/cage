/**
 * 将本体中的审批绑定和路由 JSON 投影为业务流程图的审批步骤。
 * 由流程图读取层调用，沿主要实现找到审批，再按声明顺序翻译条件、选人及会签规则。
 * 不导入审批引擎、不执行条件或选人；取消和普通关联不展开审批，缺路由时保留空步骤说明证据不足。
 */
import type { BusinessStep } from './graph-business.js';
import type { GraphModel, ViewNode } from './graph-model.js';
import type { ApprovalRouteStep as RouteStep, ApprovalAiRouteStep as AiRouteStep,
  ApprovalRouteNode as RouteNode, ApprovalRouteCondition as RouteCondition } from './approval-tree.js';

/**
 * 审批子图的一步显示数据，序号是展示顺序，不对应数据库任务 ID。
 */
export interface ApprovalTask {
  /** 按声明树遍历递增的定位序号，从 1 开始；不同并行分支的序号不表示执行先后。 */
  number: number;
  /** 步骤名称，智能步骤同样保留声明标题。 */
  title: string;
  /** 由选人规则生成的中文角色/部门/用户说明。 */
  actor: string;
  /** 同意规则或智能审查说明，不是实际执行结论。 */
  rule: string;
  /** 用于人工任务规则展示的 any/all 标记。 */
  mode: 'any' | 'all';
}
/**
 * 按声明保留的步骤组；condition 缺省表示无条件，tasks 按原顺序展示。
 */
export interface ApprovalGroup {
  /** 条件组的中文表达；缺省表示无条件步骤组。 */
  condition?: string;
  /** 该组按声明顺序排列的任务，条件不满足时整组跳过。 */
  tasks: ApprovalTask[];
  /** 条件组包含嵌套容器时保存其子组；与 tasks 二选一，不将并行叶节点扁平为顺序。 */
  groups?: ApprovalGroup[];
  /** AND 并行容器，分支同时启动且内部顺序独立，全部满足后才汇合。 */
  parallel?: { title: string; branches: { title: string; groups: ApprovalGroup[] }[] };
}
/**
 * 主要审批的阅读投影，route 缺省及空 groups 表示当前抽取没有绑定路线证据。
 */
export interface ApprovalFlow {
  /** 主要审批声明节点，提供起止和领域归属证据。 */
  approval: ViewNode;
  /** 找到的审批路由节点；缺省表示当前图没有可展开路由。 */
  route?: ViewNode;
  /** 按原路由顺序归并的条件组与任务。 */
  groups: ApprovalGroup[];
}

/** 只展开阶段的主要审批。details 中作为实现依据出现的审批不代表此处执行审批；
 * 取消动作也不能被画成重新走一轮审批。步骤顺序完全来自绑定的 route。 */
/**
 * 为业务步骤提取主要审批的路线，不展开仅作为 details 的旁证审批。
 * @param model 语义图。
 * @param step 当前阅读步骤，取消和对象关联返回 undefined。
 * @param labels 字段、状态与角色中文覆盖。
 * @returns 审批与按顺序分组的任务；不运行条件、不选人、不检查授权。
 */
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
          : item.approver.kind === 'field' ? `${fieldName(item.approver.field)}指定的审批人` : `指定用户 ${item.approver.userId}`,
    rule: [item.mode === 'all' ? '所有审批人同意后继续' : item.actions?.addSign ? '任一原审批人同意' : '任一审批人同意即可继续',
      ...(item.assignment === 'candidate' ? ['候选共享一项任务，领取后处理'] : []),
      ...(item.actions?.addSign ? ['支持前签、后签和并行加签，全部加签人同意后继续'] : []),
      ...(item.actions?.transfer ? ['允许转办'] : []), ...(item.actions?.delegate ? ['允许委派，归还后由原负责人决定'] : []),
      ...(item.sla ? [`节点总时限 ${item.sla.durationMinutes} 自然分钟${item.sla.remindBeforeMinutes ? `，提前 ${item.sla.remindBeforeMinutes} 分钟提醒` : ''}；超时仅提醒`] : [])].join('；'),
    mode: item.mode,
  });
  /** 条件内只有普通叶步骤时保留原协议；含嵌套条件/并行时保留树，避免旧图把分支误连成一条链。 */
  const groups = (nodes: readonly RouteNode[]): ApprovalGroup[] => nodes.map(item => {
    if (item.kind === 'parallel') return { tasks: [], parallel: { title: item.title,
      branches: item.branches.map(branch => ({ title: branch.title, groups: groups(branch.nodes) })) } };
    if (item.kind === 'when') return { condition: conditionName(item.cond),
      ...(item.steps.every(node => node.kind === 'step' || node.kind === 'ai') ?
        { tasks: item.steps.map(node => task(node as RouteStep | AiRouteStep)) } : { tasks: [], groups: groups(item.steps) }) };
    return { tasks: [task(item)] };
  });
  return {
    approval,
    route,
    groups: groups(route.attrs.nodes as RouteNode[]),
  };
}

/** 从真实驳回结论绑定辨认出口，不依赖阶段标题里是否含有“驳回”二字。 */
/**
 * 用真实 onRejected 绑定辨认驳回出口，不从标题猜测。
 * @param flow 当前审批投影。
 * @param target 待检查的命令或业务阶段。
 * @returns 目标主要命令是否等于驳回结论，纯计算无副作用。
 */
export function isApprovalRejection(flow: ApprovalFlow, target: BusinessStep): boolean {
  const command =
    target.node.kind === 'command'
      ? target.node.key
      : target.node.kind === 'stage'
        ? target.node.attrs.primary
        : undefined;
  return command === `command:${flow.approval.attrs.onRejected}`;
}
