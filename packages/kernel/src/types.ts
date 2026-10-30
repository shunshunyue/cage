// 内核公共类型：上下文 ctx、主体、范围授权。

/** 主体种类。系统身份（process/job/external/reaction）只能调用声明了对应 invokedBy 的命令，或自己声明过的命令。 */
export type ActorKind = 'user' | 'process' | 'job' | 'external' | 'reaction' | 'system' | 'anonymous';

export interface Actor {
  kind: ActorKind;
  /** 用户 id，或系统身份名，例如 job:expireStaleOrders */
  id: string;
}

/** 写入来源，记入审计 */
export type Source = 'api' | 'process' | 'job' | 'import' | 'external' | 'reaction' | 'system';

/** 范围组合子：封闭集合，每个都同时有内存语义和 SQL 语义 */
export type Combinator = 'all' | 'self' | 'dept' | 'deptSubtree' | 'deptSet';
export const COMBINATORS: readonly Combinator[] = ['all', 'self', 'dept', 'deptSubtree', 'deptSet'];
/** 组合子由窄到宽的顺序，用于「不能授出比自己更宽的范围」 */
export const COMBINATOR_WIDTH: Record<Combinator, number> = { self: 0, dept: 1, deptSet: 2, deptSubtree: 2, all: 3 };

/** 角色在某个聚合上的数据范围授权 */
export interface ScopeGrant {
  combinator: Combinator;
  /** deptSet 用：角色配置的部门集合 */
  deptIds?: string[];
}

/** 能力点参数，例如 { ceiling: 50000 } */
export type CapabilityParams = Record<string, unknown>;

/** 当前主体的上下文。HTTP 认证、审批桥接、调度器、反应各自构造它，交给内核。 */
export interface Ctx {
  actor: Actor | null;
  /** 当前真人用户；系统身份时为 null（真人在 onBehalfOf） */
  userId: string | null;
  /** 系统身份代表的真人，用于职责分离和审计 */
  onBehalfOf?: string | null;
  tenantId: string;
  deptId: string | null;
  /** 当前部门的祖先路径（含自己），例如 /root/purchase/ */
  deptPath: string | null;
  /** 能力集合及参数；多角色取并集，额度取最大值 */
  capabilities: Map<string, CapabilityParams>;
  /** 各聚合上的范围授权，多角色取并集（OR）；未配置的聚合按「仅本人」 */
  scopes: Record<string, ScopeGrant[]>;
  /** 可以看明文的「聚合.种类」，例如 PurchaseOrder.phone */
  unmask: string[];
  source: Source;
  requestId?: string;
  idempotencyKey?: string;
  /** 二次认证时间（毫秒时间戳） */
  stepUpAt?: number | null;
  client?: { ip?: string; userAgent?: string };
  /** onBehalfOf 那个人的能力（额度类约束按他判断）；内核会按需加载 */
  onBehalfOfCapabilities?: Map<string, CapabilityParams>;
}

export type MaybePromise<T> = T | Promise<T>;
