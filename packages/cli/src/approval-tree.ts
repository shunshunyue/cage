/**
 * 审批声明 JSON 的只读结构与遍历工具，供本体抽取、字段关系说明和静态流程图共同消费。
 * 仅遍历 when、parallel 和 branch 保留的声明树，不执行条件、选人、审批引擎或实际实例状态。
 * 浏览器可引用这些类型和纯函数，不引入 approval 运行时；标题和依赖始终来自抽取快照。
 */

/** 人工步骤的静态可解释元数据；未知扩展由抽取原始 JSON 保留，本投影不据此执行业务。 */
export interface ApprovalRouteStep {
  /** 人工步骤判别，不同于 parallel 的分支容器。 */
  kind: 'step';
  /** 提交政策中的标题和同节点原始审批票完成规则。 */
  title: string;
  mode: 'any' | 'all';
  /** candidate 表示共享领取；不代表分支并行或多人会签。 */
  assignment?: 'direct' | 'candidate';
  /** 任务管理开关与自然分钟总时限，只作说明，不表示已经发生。 */
  actions?: { transfer?: boolean; delegate?: boolean; addSign?: boolean };
  sla?: { durationMinutes: number; remindBeforeMinutes?: number };
  /** 封闭选人策略；被选中不代表拥有业务命令能力。 */
  approver: { kind: 'deptLeader'; field: string } | { kind: 'field'; field: string } |
    { kind: 'role'; code: string } | { kind: 'user'; userId: string };
}

/** AI 步骤只暴露绘图及取证依赖所需字段；提示词不由本遍历器加入公开图。 */
export interface ApprovalAiRouteStep {
  /** AI 节点判别；其人工接管仍归属于同一声明节点。 */
  kind: 'ai';
  /** 展示标题，不能作为实例节点的唯一身份或执行顺序。 */
  title: string;
  /** 转人工时的封闭选人策略，图谱只说明来源，不授予处理权限。 */
  handoff: ApprovalRouteStep['approver'];
  /** CLI 本体依据这些白名单画 uses/queries 关系，不实际读取数据。 */
  context?: { fields: readonly string[]; queries?: readonly string[] };
}

/** 条件比较保留精确运算符与边界，不按展示顺序推断运行时是否满足。 */
export interface ApprovalRouteCondition {
  /** 提交快照中的条件字段，由注册表校验是否进入 routable。 */
  field: string;
  /** 已声明的封闭比较方式；静态图不调用条件求值。 */
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'in';
  /** 固定阈值或集合，沿用原声明的类型和数值，不根据中文标签重新推断。 */
  value: string | number | boolean | (string | number)[];
}

/** AND 分支内部为顺序声明，可继续含有条件和嵌套并行。 */
export interface ApprovalRouteBranch {
  /** 分支容器判别；不能单独当作可分配任务。 */
  kind: 'branch';
  /** 所属并行组内唯一的名称，用于静态说明和分支定位。 */
  title: string;
  /** 分支内部的顺序子树；嵌套容器保留，不摊平成全流程顺序。 */
  nodes: ApprovalRouteNode[];
}

/** 结构化路由树；parallel 必须等待全部活动分支，when 在实例启动时按快照求值。 */
export type ApprovalRouteNode = ApprovalRouteStep | ApprovalAiRouteStep |
  { kind: 'when'; cond: ApprovalRouteCondition; steps: ApprovalRouteNode[] } |
  { kind: 'parallel'; title: string; branches: ApprovalRouteBranch[] };

/**
 * 按声明的深度优先次序遍历全部节点，保留容器供条件解释使用，分支本身不是可执行步骤。
 * 本函数不排序或改写源树；声明深度/数量由注册器限制，序号只能作为静态定位，不能当执行先后。
 */
export function approvalRouteNodes(nodes: readonly ApprovalRouteNode[]): ApprovalRouteNode[] {
  return nodes.flatMap(node => [node, ...(node.kind === 'when' ? approvalRouteNodes(node.steps) :
    node.kind === 'parallel' ? node.branches.flatMap(branch => approvalRouteNodes(branch.nodes)) : [])]);
}

/** 收集全部人工/AI 叶节点，用于取证与选人依赖；并行结构仍需由调用方从原树单独保留。 */
export function approvalRouteSteps(nodes: readonly ApprovalRouteNode[]): (ApprovalRouteStep | ApprovalAiRouteStep)[] {
  return approvalRouteNodes(nodes).filter((node): node is ApprovalRouteStep | ApprovalAiRouteStep => node.kind === 'step' || node.kind === 'ai');
}
