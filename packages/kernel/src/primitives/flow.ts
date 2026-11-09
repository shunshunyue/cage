/**
 * 声明事件反应、只读查询、审批绑定、定时任务与显式逃生口。
 * 这些规格由注册表、CLI 和对应运行服务消费：写回必须调用命令，读取遵守声明依赖，审批选人不授予能力，资源标签只供静态检查，不自动产生锁或释放动作。
 */
// reaction、query、approval、job、unsafe 原语。
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { APPROVAL, JOB, QUERY, REACTION, UNSAFE } from '../brands.js';
import { declError } from '../errors.js';
import type { AnyAggregate, FieldsOf, SnapshotOf } from './aggregate.js';
import type { AnyCommand } from './command.js';
import type { AnyEvent, PayloadOf } from './event.js';

// ---------------- reaction ----------------

/** same 与触发命令共同提交/回滚；outbox 在提交后由 worker 另开事务，可能重试或进入死信。 */
export type TxMode = 'outbox' | 'same';

/**
 * 事件到目标命令的冻结连接规格，普通反应输出单个输入，集合反应可展开多个输入。
 * map 只做纯映射，null 跳过；真实执行仍走目标命令权限/状态/版本与审计，事务模式决定同提交还是异步恢复。
 */
export interface Reaction<E extends AnyEvent = AnyEvent, C extends AnyCommand = AnyCommand> {
  /**
   * 反应品牌标记，用于注册和静态抽取。
   */
  readonly [REACTION]: true;
  /**
   * 触发源事件声明，载荷由对应事件 schema 校验。
   */
  readonly event: E;
  /**
   * 每次反应实际调用的目标命令，不能用标签替代其业务逻辑。
   */
  readonly command: C;
  /** 作用的聚合（等于 command.agg，写出来便于阅读） */
  readonly target: AnyAggregate;
  /** 把事件载荷映射成命令输入（纯函数）；返回 null 表示这次不处理 */
  readonly map: (e: PayloadOf<E>) => z.input<C['input']> | readonly z.input<C['input']>[] | null;
  /** 同一事件、同一事务模式中的显式步骤序号；启用后各步骤必须完整、唯一地声明。 */
  readonly order?: number;
  /** 有界集合的可检查元数据；集合仍逐项经过命令流水线。 */
  readonly collection?: { /** 集合原始项数上限，在纯映射跳过项之前检查。 */ readonly maxItems: number; /** 稳定排序字段，所有项需同类型唯一键。 */ readonly orderBy: string; /** 集合选择器源码快照，供静态检查和图谱证据使用，不在运行时 eval。 */ readonly itemsSource: string; /** 逐项输入映射源码快照，供静态解释，不代替真实回调执行。 */ readonly mapSource: string };
  /** 事务语义：outbox 异步（默认，见 D3）；same 与触发命令同一事务 */
  readonly tx: TxMode;
  /** 获得的资源，供资源配对检查使用 */
  readonly acquires?: string;
  /** 释放的资源 */
  readonly releases?: string;
  /**
   * 可选反应标识；省略时注册/抽取层按导出声明识别，不是资源名。
   */
  readonly name?: string;
}

/**
 * 容纳不同事件载荷和命令输入的反应擦除类型，供注册表和消费者遍历；声明时仍保留精确泛型。
 */
export type AnyReaction = Reaction<AnyEvent, AnyCommand>;

/**
 * 声明事件到命令的映射，默认使用 outbox 异步执行。target 若显式提供必须与命令所属聚合一致。
 * order 是同一事件步骤的显式顺序；acquires/releases 仅用于静态资源配对，实际动作由命令实现。
 */
export function reaction<E extends AnyEvent, C extends AnyCommand>(
  ev: E,
  def: {
    /** 事件发生后调用的目标命令，其聚合就是实际 target。 */
    command: C;
    /** 从已校验事件载荷同步生成命令输入的纯映射，返回 null 表示该事件不执行此反应。 */
    map: (e: PayloadOf<E>) => z.input<C['input']> | null;
    /** 可选显式目标聚合，提供时必须与 command.agg 为同一声明对象；省略自动取命令聚合。 */
    target?: AnyAggregate;
    /** 省略时 outbox，由 worker 提交后异步处理；same 表示与触发命令同事务回滚。 */
    tx?: TxMode;
    /** 可选取得资源标签，供静态配对检查，不自动创建占用。 */
    acquires?: string;
    /** 可选释放资源标签，供静态配对检查，真实释放由目标命令实现。 */
    releases?: string;
    /** 可选反应名，用于注册、图谱和诊断识别。 */
    name?: string;
    /** 同一事件/事务组的非负步骤序号；组内使用时需完整且不重复，不依赖导出排序。 */
    order?: number;
  },
): Reaction<E, C> {
  if (def.target && def.target !== def.command.agg) {
    throw declError('CAGE-REACT-001', `反应的 target 与 command 所属聚合不一致`);
  }
  if (def.order !== undefined && (!Number.isSafeInteger(def.order) || def.order < 0)) {
    throw declError('CAGE-REACT-003', '反应 order 必须为非负安全整数');
  }
  return Object.freeze({
    [REACTION]: true as const,
    event: ev,
    command: def.command,
    target: def.command.agg,
    map: def.map,
    tx: def.tx ?? 'outbox',
    acquires: def.acquires,
    releases: def.releases,
    name: def.name,
    order: def.order,
  });
}

// ---------------- query ----------------

/**
 * 已声明的命名查询规格，input 解析参数，reads 明确所有读取聚合及对应 read 权限。
 * sql/build 恰选一个；安全只读账号、事务会话和审计由读侧执行层提供，说明文字不能替代真实查询边界。
 */
export interface Query<I extends z.ZodType = z.ZodType> {
  /**
   * 命名查询品牌标记，不表示已经执行或授权。
   */
  readonly [QUERY]: true;
  /**
   * 稳定小驼峰查询名，形成客户端查询入口和本体 key。
   */
  readonly name: string;
  /** 查询读了哪些聚合：只能引用它们的安全视图；调用者需要每个聚合的 read 能力 */
  readonly reads: readonly AnyAggregate[];
  /**
   * 输入 Zod schema；省略声明时规范化为空对象，运行时使用解析后的输出值绑定参数。
   */
  readonly input: I;
  /** 手写 SQL：只能引用 safe.* 视图，参数用 :name 占位 */
  readonly sql?: string;
  /** 查询构建器写法：db 是只读账号上的 Kysely，只映射安全视图 */
  readonly build?: (db: Kysely<any>, input: z.output<I>) => { /** 执行已构建安全只读查询并返回行数组，调用方可 await；不暴露业务写方法。 */ execute(): Promise<unknown[]> };
  /**
   * 查询口径与用途说明，供本体和契约展示；统计完整性仍由查询实现与分页边界决定。
   */
  readonly description?: string;
  /** 用途级可靠审计；敏感明文查询另会自动审计所涉及聚合。 */
  readonly audit?: { /** 固定非空用途说明，供可靠审计；不得拼接用户输入或敏感查询条件。 */ readonly purpose: string };
}

/**
 * 异构查询容器类型，保留公共规格但擦除具体输入 schema，生成契约仍使用原声明推导参数。
 */
export type AnyQuery = Query<z.ZodType>;

/**
 * 声明只读查询，SQL 和构建器必须恰选一种。SQL 仅允许安全视图，reads 决定授权和审计范围。
 * 构造时检查明显基表引用和空审计用途；实际运行还要验证输入、read 能力并注入事务会话变量。
 */
export function query<I extends z.ZodType = z.ZodObject<{}>>(
  name: string,
  def: {
    /** 所有访问聚合的声明白名单，包括 join 对象；调用者需全部 read 能力。 */
    reads: AnyAggregate[];
    /** 可选参数 schema，省略默认空对象；build 接收解析后的 z.output。 */
    input?: I;
    /** 与 build 二选一的参数化 SQL，使用 safe 视图及 :name 参数，禁止拼接用户值。 */
    sql?: string;
    /** 与 sql 二选一的查询构建回调，接收只读 Kysely 和已解析输入，返回可 execute 的行查询。 */
    build?: (db: Kysely<any>, input: z.output<I>) => { /** 执行构建出的只读语句并返回行数组，权限与会话范围由读侧提供。 */ execute(): Promise<unknown[]> };
    /** 查询业务口径说明，供本体、文档和模型工具理解。 */
    description?: string;
    /** 可选用途级可靠审计声明；审计失败时读侧不交付结果，敏感读取另有保守审计。 */
    audit?: { /** 非空固定查询用途，不能把敏感参数拼入说明。 */ purpose: string };
  },
): Query<I> {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-005', `查询名 ${name} 必须是小驼峰`);
  if (!def.sql === !def.build) throw declError('CAGE-QUERY-001', `查询 ${name} 必须二选一：sql 或 build`);
  if (def.sql && /\bcore\.|\bsys\./i.test(def.sql)) {
    throw declError('CAGE-QUERY-002', `查询 ${name} 引用了基表，只能引用 safe.* 安全视图`);
  }
  if (def.audit && !def.audit.purpose.trim()) throw declError('CAGE-QUERY-003', `查询 ${name} 的审计 purpose 不能为空`);
  return Object.freeze({
    [QUERY]: true as const,
    name,
    reads: Object.freeze([...def.reads]),
    input: (def.input ?? z.object({})) as I,
    sql: def.sql,
    build: def.build,
    description: def.description,
    audit: def.audit ? Object.freeze({ ...def.audit }) : undefined,
  });
}

// ---------------- approval ----------------

/**
 * 聚合事件与审批流程的绑定规格，不含流程选人或当前待办状态。
 * start/cancelOn 驱动实例生命周期，结论通过所属聚合 process 命令落实；自动审核身份从 automatedBy 当前角色授权解析。
 */
export interface Approval<A extends AnyAggregate = AnyAggregate> {
  /**
   * 审批绑定品牌标记，不创建待办或流程实例。
   */
  readonly [APPROVAL]: true;
  /**
   * 审批业务主体聚合，所有通过/驳回/退回结论命令必须属于它。
   */
  readonly agg: A;
  /** 流程名，例如 po-approval */
  readonly process: string;
  /** 哪个事件启动流程 */
  readonly start: AnyEvent;
  /** 哪些事件取消流程（例如撤回、取消） */
  readonly cancelOn: readonly AnyEvent[];
  /** 可路由字段：只有它们会作为流程变量传给引擎 */
  readonly routable: readonly (keyof FieldsOf<A> & string)[];
  /** 通过与驳回分别落到哪个命令（必须 invokedBy: process） */
  readonly onApproved: AnyCommand;
  /**
   * 最终驳回对应的 process 命令，必须与主体同聚合；不同于可修改后重提的 onReturned。
   */
  readonly onRejected: AnyCommand;
  /** 退回修改独立于最终驳回；重新提交会创建新审批轮次。 */
  readonly onReturned?: AnyCommand;
  /** 自动节点使用的角色 code；权限与范围从当前角色授权解析。 */
  readonly automatedBy?: string;
}

/**
 * 将聚合事件绑定到审批流程及结论命令；此处只验证字段和结论归属，不创建待办。
 * routable 限制传给流程的字段，结论命令必须接受 process 身份；选人和最终命令授权仍独立判断。
 * onReturned 开启修改后再提交的轮次语义，automatedBy 指向运行时解析授权的角色 code。
 */
export function approval<A extends AnyAggregate>(
  agg: A,
  def: {
    /** 已声明路由/适配器的流程标识，与审批实例关联，不是角色名。 */
    process: string;
    /** 启动审批的领域事件，需由真实命令发出并经桥接处理。 */
    start: AnyEvent;
    /** 取消相关审批轮次的事件列表，省略为空；不自动推导所有撤回路径。 */
    cancelOn?: AnyEvent[];
    /** 允许交给流程引擎的业务字段名白名单，字段必须属于主体聚合。 */
    routable: (keyof FieldsOf<A> & string)[];
    /** 通过后执行的主体聚合命令，必须允许 process 身份，仍执行能力/范围/约束校验。 */
    onApproved: AnyCommand;
    /** 最终驳回命令，与主体同聚合且允许 process；不同于退回修改。 */
    onRejected: AnyCommand;
    /** 可选退回修改命令，同样要求主体聚合/process 身份；重新提交另建审批轮次。 */
    onReturned?: AnyCommand;
    /** 可选自动审批执行角色 code，运行时读取其当前授权，不因配置存在就自动授予业务能力。 */
    automatedBy?: string;
  },
): Approval<A> {
  for (const f of def.routable) {
    if (!(f in agg.fields)) throw declError('CAGE-APPR-001', `可路由字段 ${agg.name}.${f} 不存在`);
  }
  for (const c of [def.onApproved, def.onRejected, ...(def.onReturned ? [def.onReturned] : [])]) {
    if (c.agg !== agg) throw declError('CAGE-APPR-002', `审批结论命令必须属于 ${agg.name}`);
    if (!c.invokedBy.includes('process')) {
      throw declError('CAGE-APPR-003', `审批结论命令必须声明 invokedBy: 'process'`);
    }
  }
  return Object.freeze({
    [APPROVAL]: true as const,
    agg,
    process: def.process,
    start: def.start,
    cancelOn: Object.freeze([...(def.cancelOn ?? [])]),
    routable: Object.freeze([...def.routable]),
    onApproved: def.onApproved,
    onRejected: def.onRejected,
    onReturned: def.onReturned,
    automatedBy: def.automatedBy,
  });
}

// ---------------- job ----------------

/**
 * 调度器注入的受限读入口，只允许 job.reads 中的聚合，始终限定当前租户和运行身份范围。
 * 查询返回内部业务快照而非浏览器展示 DTO，不把此接口暴露成任意客户端查询。
 */
export interface JobQueryApi {
  /** 只读查询：等值条件，另支持 createdBefore / createdAfter / updatedBefore */
  list<A extends AnyAggregate>(
    agg: A,
    where?: Partial<SnapshotOf<A>> & { /** 创建时间严格早于此时间，接收 Date 或可解析时间字符串。 */ createdBefore?: Date | string; /** 创建时间严格晚于此时间，用于受限增量范围。 */ createdAfter?: Date | string; /** 更新时间严格早于此时间，适合按任务固定 now 查找过期记录。 */ updatedBefore?: Date | string },
    opts?: { /** 返回条数，默认 1000、底层最多 5000；没有分页游标或自动全表遍历。 */ limit?: number },
  ): Promise<SnapshotOf<A>[]>;
}

/** 调度器为单租户单次任务注入的受限能力；不要缓存到下一轮或用于绕过 reads/calls。 */
export interface JobApi {
  /**
   * 只提供读取已声明聚合的查询方法，不暴露数据库连接或写仓储。
   */
  query: JobQueryApi;
  /** 只能调用 calls 里声明过的命令；每次调用都走完整流水线，审计 source = job */
  call<C extends AnyCommand>(cmd: C, input: z.input<C['input']>): Promise<SnapshotOf<C['agg']>>;
  /**
   * 本次调度所处理的租户 ID，调用方不能跨租户复用该 api。
   */
  tenantId: string;
  /**
   * 本次任务固定参考时间，由调度器传入；可用于同轮过期判断，不能假定等于每个内部命令的写入时间。
   */
  now: Date;
  /**
   * 结构化任务日志入口，自动附任务名；extra 不应写入凭据或业务敏感明文。
   */
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * 定时任务的冻结规格，调度器按 cron 和逐租户生命周期执行 run。
 * reads/calls 是实际白名单和图谱依赖，任务不能绕过命令直接写表；run 完成不代表多次独立命令自动成为同一事务。
 */
export interface Job {
  /**
   * 定时任务品牌标记，供注册与调度发现。
   */
  readonly [JOB]: true;
  /**
   * 小驼峰任务名称，形成执行身份、日志和调度记录标识。
   */
  readonly name: string;
  /** cron 表达式，例如 0 2 * * * */
  readonly cron: string;
  /**
   * 允许查询的冻结聚合列表，省略声明时为空；未声明的读取在运行时拒绝。
   */
  readonly reads: readonly AnyAggregate[];
  /**
   * 允许调用的冻结命令列表，省略声明时为空；列入仍走命令完整流水线。
   */
  readonly calls: readonly AnyCommand[];
  /**
   * 调度器为当前租户注入 JobApi 后调用的异步任务体；失败抛出由调度器记录，外部 IO 需走连接器。
   */
  readonly run: (api: JobApi) => Promise<void>;
  /**
   * 任务业务目的说明，帮助图谱与诊断定位，不影响 cron 解释。
   */
  readonly description?: string;
}

/**
 * 声明定时任务的时间表和读写依赖，不立即启动定时器。调度器负责跨实例互斥和逐租户执行。
 * reads/calls 是运行时白名单也是图谱证据；cron 在这里做基本形状校验，具体解释交给调度器。
 */
export function job(
  name: string,
  def: { /** 任务时间表达式，声明期只校验基本字段数，具体解释与时区由调度器使用的 cron 实现决定。 */ cron: string; /** 可查询聚合白名单，省略为空；运行时访问未声明聚合会拒绝。 */ reads?: AnyAggregate[]; /** 可调用命令白名单，省略为空；内部命令还须允许对应身份。 */ calls?: AnyCommand[]; /** 当前租户任务体，只通过注入 query/call/log 等能力工作；失败抛出由调度器记录，不自动包成跨命令总事务。 */ run: (api: JobApi) => Promise<void>; /** 可选任务目的和边界说明，供图谱及诊断展示。 */ description?: string },
): Job {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-006', `任务名 ${name} 必须是小驼峰`);
  if (def.cron.trim().split(/\s+/).length < 5) throw declError('CAGE-JOB-001', `任务 ${name} 的 cron 表达式不合法`);
  return Object.freeze({
    [JOB]: true as const,
    name,
    cron: def.cron,
    reads: Object.freeze([...(def.reads ?? [])]),
    calls: Object.freeze([...(def.calls ?? [])]),
    run: def.run,
    description: def.description,
  });
}

/** 返回参考时间之前 n×24 小时的 Date，from 缺省当前时间；按毫秒减法而非日历时区日计算，不修改传入 Date。 */
export function daysAgo(n: number, from = new Date()): Date {
  return new Date(from.getTime() - n * 24 * 3600 * 1000);
}

// ---------------- unsafe ----------------

/** 逃生口的责任记录；reason 说明现有原语为何不足，owner 指向后续审查与收敛负责人。 */
export interface UnsafeTag {
  /**
   * 说明现有原语不能表达的具体原因及特殊边界，不能为空。
   */
  readonly reason: string;
  /**
   * 负责审查和后续收敛的责任人标识，不能为空；不作为系统授权身份。
   */
  readonly owner: string;
}

/**
 * 逃生口：声明表达不了时使用，必须写明原因和负责人。lint 检查参数，计数进 PR 摘要。
 * 校验标签后立即调用 fn 并原样返回结果/抛出异常；不会授予数据库、网络或用户权限，也不会关闭依赖与 lint 门禁。
 *   const v = unsafe({ reason: '…', owner: 'zhangsan' }, () => …)
 */
export function unsafe<T>(tag: UnsafeTag, fn: () => T): T {
  if (!tag?.reason || !tag?.owner) throw declError('CAGE-UNSAFE-001', 'unsafe 必须写明 reason 和 owner');
  return fn();
}
(unsafe as any)[UNSAFE] = true;
