/**
 * 定义内核授权上下文、调用主体、来源和数据范围的公共类型。
 * 认证、审批、任务与反应在服务端组装这些值，写流水线、安全读和审计共同消费；业务输入不能自行指定可信身份，类型描述也不等于已经验证或授予权限。
 */
// 内核公共类型：上下文 ctx、主体、范围授权。

/** 主体种类。系统身份（process/job/external/reaction）只能调用声明了对应 invokedBy 的命令，或自己声明过的命令。 */
export type ActorKind = 'user' | 'process' | 'job' | 'external' | 'reaction' | 'system' | 'anonymous';

/** 审计主体；id 的解释依赖 kind，系统主体名称不能当作真人用户 ID 使用。 */
export interface Actor {
  /**
   * 真实调用身份类型，决定调用入口边界；真人委托信息放在 Ctx.onBehalfOf，不伪装为 user。
   */
  kind: ActorKind;
  /** 用户 id，或系统身份名，例如 job:expireStaleOrders */
  id: string;
}

/** 写入来源，记入审计 */
export type Source = 'api' | 'process' | 'job' | 'import' | 'external' | 'reaction' | 'system';

/** 范围组合子：封闭集合，每个都同时有内存语义和 SQL 语义 */
export type Combinator = 'all' | 'self' | 'dept' | 'deptSubtree' | 'deptSet';
/**
 * 内核支持的数据范围组合子白名单，供配置校验与目录发现使用。
 * 具体数据判定由 scope 的 SQL 和内存实现承担，数组顺序不等于范围授权的包含关系。
 */
export const COMBINATORS: readonly Combinator[] = ['all', 'self', 'dept', 'deptSubtree', 'deptSet'];
/** 组合子由窄到宽的顺序，用于「不能授出比自己更宽的范围」 */
export const COMBINATOR_WIDTH: Record<Combinator, number> = { self: 0, dept: 1, deptSet: 2, deptSubtree: 2, all: 3 };

/** 角色在某个聚合上的数据范围授权 */
export interface ScopeGrant {
  /**
   * 此条授权采用的范围规则，多条授权按 OR 合并；all 仍受租户边界限制。
   */
  combinator: Combinator;
  /** deptSet 用：角色配置的部门集合 */
  deptIds?: string[];
}

/** 能力点的可选参数，由声明和自定义约束解释，不隐含审批规则。 */
export type CapabilityParams = Record<string, unknown>;

/** 当前主体的上下文。HTTP 认证、审批桥接、调度器、反应各自构造它，交给内核。 */
/**
 * ctx 是可信服务端组装的授权快照，不是客户端可直接提交的请求体。
 * capabilities 决定能做什么，scopes 决定可操作哪些记录，invokedBy 另由命令声明检查；
 * 三者不可互相替代。异步处理派生上下文时要保留租户、真人委托和追踪信息。
 */
export interface Ctx {
  /**
   * 可信服务端主体；null 表示尚无身份，匿名公共调用也需显式 anonymous 主体。
   */
  actor: Actor | null;
  /** 当前真人用户；系统身份时为 null（真人在 onBehalfOf） */
  userId: string | null;
  /** 系统身份代表的真人，用于职责分离和审计 */
  onBehalfOf?: string | null;
  /** 所有数据库读写和异步事件的租户边界，不允许通过业务输入覆盖。 */
  tenantId: string;
  /**
   * 当前主体关联部门 ID；无部门时为 null，不能据空值自动扩展到全租户。
   */
  deptId: string | null;
  /** 当前部门的祖先路径（含自己），例如 /root/purchase/ */
  deptPath: string | null;
  /** 能力集合及参数；多角色取并集，同名数值参数取最大值。 */
  capabilities: Map<string, CapabilityParams>;
  /** 各聚合上的范围授权，多角色取并集（OR）；具体聚合缺省时可使用 * 通配授权，仍未配置则按仅本人处理。 */
  scopes: Record<string, ScopeGrant[]>;
  /** 可以看明文的「聚合.种类」，例如 PurchaseOrder.phone */
  unmask: string[];
  /**
   * 本次业务入口来源，写入审计和异步关联，不独立授予对应调用身份或能力。
   */
  source: Source;
  /** 跨 HTTP、命令审计和 outbox 关联同一次请求；不承担业务去重。 */
  requestId?: string;
  /** 同一次逻辑提交重试时复用；未提供时不会自动合并两次独立业务操作。 */
  idempotencyKey?: string;
  /** 二次认证时间（毫秒时间戳） */
  stepUpAt?: number | null;
  /**
   * 可选客户端来源信息，包含 IP 和 User-Agent，仅作审计上下文，不作为业务授权依据。
   */
  client?: { /** 可选来源 IP，供审计关联；不作为用户或租户身份依据。 */ ip?: string; /** 可选浏览器/客户端标识，属于不可信展示文本，不参与能力判断。 */ userAgent?: string };
  /** onBehalfOf 那个人的能力；约束需要时由内核按需加载。 */
  onBehalfOfCapabilities?: Map<string, CapabilityParams>;
}

/** 声明回调既可同步计算，也可等待框架允许的读依赖；调用侧始终可以 await。 */
export type MaybePromise<T> = T | Promise<T>;
