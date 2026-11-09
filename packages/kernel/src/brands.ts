// 品牌标记：抽取器、注册表和内核靠它们识别原语返回的描述对象。
// 使用 Symbol.for，即使同一个包被加载两份，标记也相同。

/** 持久化对象声明；注册表据此收集字段、状态、范围和不变量。 */
export const AGGREGATE = Symbol.for('cage.aggregate');
export const STATES = Symbol.for('cage.states');
export const COMMAND = Symbol.for('cage.command');
export const EVENT = Symbol.for('cage.event');
export const REACTION = Symbol.for('cage.reaction');
export const QUERY = Symbol.for('cage.query');
export const APPROVAL = Symbol.for('cage.approval');
export const JOB = Symbol.for('cage.job');
export const BUSINESS_PROCESS = Symbol.for('cage.businessProcess');
export const UNSAFE = Symbol.for('cage.unsafe');
// 以下原语由 @yss123/cage-connectors、@yss123/cage-approval 实现，标记放在这里统一管理
export const CONNECTOR = Symbol.for('cage.connector');
export const OUTBOUND = Symbol.for('cage.outbound');
export const INBOUND = Symbol.for('cage.inbound');
export const ROUTE = Symbol.for('cage.route');

// 运行时扩展点：带这个标记的声明对象可以向 worker 提供事件消费者
export const CONSUMERS = Symbol.for('cage.consumers');
// 运行时扩展点：带这个标记的声明对象可以提供框架自己的系统表 DDL
export const SYSTEM_DDL = Symbol.for('cage.systemDdl');
// 基础设施扩展，不增加领域原语：服务自行提供迁移、HTTP 与后台处理器。
export const RUNTIME = Symbol.for('cage.runtime');
export const MIGRATIONS = Symbol.for('cage.migrations');

/**
 * 领域声明的识别目录。这里不包含 CONSUMERS、SYSTEM_DDL 等扩展协议标记：
 * 它们描述声明附带的能力，不是一个独立业务节点，避免抽取时将同一对象重复分类。
 */
export const ALL_BRANDS = {
  AGGREGATE, STATES, COMMAND, EVENT, REACTION, QUERY, APPROVAL, JOB, BUSINESS_PROCESS, UNSAFE,
  CONNECTOR, OUTBOUND, INBOUND, ROUTE,
} as const;

/** 判断一个值属于哪种原语；不是原语返回 null。 */
/** 只读取标记，不执行声明中的回调；可安全用于模块导出的混合值筛选。 */
export function brandOf(v: unknown): keyof typeof ALL_BRANDS | null {
  if (!v || (typeof v !== 'object' && typeof v !== 'function')) return null;
  for (const [k, s] of Object.entries(ALL_BRANDS)) {
    if ((v as any)[s]) return k as keyof typeof ALL_BRANDS;
  }
  return null;
}
