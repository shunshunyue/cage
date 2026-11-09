/**
 * 声明唯一领域写入口及 handler 可使用的输入、草稿、读依赖和调用信息。
 * command 构造冻结规格，注册表确定能力名称，内核流水线执行状态、权限、版本、约束、事务、审计和事件；本文件不发 HTTP、不连接数据库、不执行 handler。
 */
// command 原语：一次写操作。命令名由导出的变量名决定：export const approve = command(PurchaseOrder, …)
// 的能力点就是 PurchaseOrder.approve。
import { z } from 'zod';
import { COMMAND } from '../brands.js';
import { declError, type DomainError } from '../errors.js';
import type { Ctx, MaybePromise } from '../types.js';
import {
  type AnyAggregate, type FieldValuesOf, hasStates, type SnapshotOf, type StateOf,
} from './aggregate.js';
import type { Constraint } from './constraints.js';
import { type AnyEvent, type EmitSpec, toEmitSpec } from './event.js';

/** reads 的形状：别名 → 聚合 */
export type Reads = Record<string, AnyAggregate>;

/** handler 读依赖的有界查询选项；orderBy 使用业务字段名，底层负责映射与校验。 */
export interface FindOptions {
  /**
   * 期望返回条数；实现默认 1000、最多 5000，不提供 offset 或全量保证，业务应选择合理正整数。
   */
  limit?: number;
  /**
   * 排序业务字段或系统字段名；省略时按 createdAt 升序，未知字段及集合关系拒绝。
   */
  orderBy?: string;
  /**
   * 提供 orderBy 时是否降序，省略/false 为升序；未指定排序字段时不改变默认创建时间顺序。
   */
  desc?: boolean;
}

/**
 * 注入 handler 的只读仓储，绑定本次命令事务及当前数据范围，范围外对象按不存在处理。
 * 返回供服务端业务计算使用的内部快照，不是浏览器安全呈现 DTO；不要直接把它作为公开响应或绕过掩码输出。
 * 没有写方法，find/findOne 只接受声明列的等值条件；事务内读取本身不保证其他聚合的后续并发写已被锁定。
 */
export interface ReadRepo<A extends AnyAggregate> {
  /** 按 UUID 取一条内部快照，不存在、范围外或明显非法 ID 返回 null；不会取得业务更新行锁。 */
  get(id: string): Promise<SnapshotOf<A> | null>;
  /** 按等值条件读取范围内列表，省略 where 不加额外业务筛选；undefined 条件忽略，null 使用 IS NULL，集合/JSON 不能作主表筛选。 */
  find(where?: Partial<SnapshotOf<A>>, opts?: FindOptions): Promise<SnapshotOf<A>[]>;
  /** 按等值条件取默认创建时间升序的第一条，未命中为 null；不表示条件在数据库中具有唯一约束。 */
  findOne(where: Partial<SnapshotOf<A>>): Promise<SnapshotOf<A> | null>;
  /** 统计相同租户/范围内的等值条件记录数，不使用 find 的返回数量上限；未知字段及 JSON/集合条件会拒绝。 */
  count(where?: Partial<SnapshotOf<A>>): Promise<number>;
}

/**
 * 按 reads 的每个别名推导只读仓储类型；只读映射禁止替换依赖，不提供写接口。
 * 运行时访问未声明别名仍会失败，类型擦除不能绕过 CAGE-READS-001 门禁。
 */
export type DepsOf<R extends Reads> = { readonly [K in keyof R]: ReadRepo<R[K]> };

/** handler 拿到的草稿：业务字段可改；状态、主键、版本号只读，handler 改不了 */
export type Draft<A extends AnyAggregate> = FieldValuesOf<A> & {
  /** 新建草稿或当前对象的 UUID，只读，handler 不得更换对象身份。 */
  readonly id: string;
  /** 执行 handler 时的草稿/当前状态，只读；目标状态由命令 to 在合并后确定。 */
  readonly status: StateOf<A>;
  /** handler 所见草稿版本或已加载版本，只读；内核提交时维护版本递增。 */
  readonly version: number;
  /** 原始创建时间字符串，新建使用本次固定时间，handler 不改写。 */
  readonly createdAt: string;
  /** 本次草稿或已加载记录的更新时间字符串，最终更新时间由流水线设定。 */
  readonly updatedAt: string;
};

/** handler 的第四个参数：只读的调用信息 */
export interface HandlerCtx {
  /** 当前时间（同一次命令里固定） */
  readonly now: Date;
  /** 真人操作者（系统身份时为它代表的人） */
  readonly actorUserId: string | null;
}

/** 可直接修改草稿并返回 void，或返回字段补丁；DomainError 会终止整笔命令事务。 */
export type HandlerResult<A extends AnyAggregate> = Draft<A> | Partial<FieldValuesOf<A>> | DomainError | void;

/**
 * 命令声明可选择的调用入口种类。
 * 用户/匿名入口必须包含 user；框架反应按 process 入口解释，内部系统身份有专用路径。声明入口不等于授权，能力、范围和调度器 calls 白名单仍分别检查。
 */
export type Invoker = 'user' | 'process' | 'job' | 'external';

/**
 * 一次业务写入的完整规格。input 验证调用参数，reads 列明只读依赖，constraints 在 handler 前执行，
 * emits 在业务写入成功后进入同事务 outbox；handler 不能代替权限、版本或状态检查。
 */
export interface Command<
  A extends AnyAggregate = AnyAggregate,
  R extends Reads = Reads,
  I extends z.ZodType = z.ZodType,
> {
  /**
   * 声明品牌标记，供注册表识别顶层导出，不表示命令已执行。
   */
  readonly [COMMAND]: true;
  /**
   * 本命令唯一写入的聚合定义；跨聚合变化通过声明反应/其他命令组合。
   */
  readonly agg: A;
  /**
   * new 表示创建；否则为规范化冻结的允许起始状态列表，实际当前状态不匹配返回 INVALID_TRANSITION。
   */
  readonly from: readonly StateOf<A>[] | 'new';
  /** null 表示保持加锁读到的当前状态；仍检查 from、权限、版本并写审计。 */
  readonly to: StateOf<A> | null;
  /**
   * 命令输入 Zod schema，handler 接收 z.output 转换后的值；expectedVersion 由流水线单独处理。
   */
  readonly input: I;
  /**
   * 别名到聚合的冻结声明，运行时在当前事务/范围内绑定只读仓储；不因声明获得任意数据库连接。
   */
  readonly reads: R;
  /**
   * 规范化事件及可选载荷映射列表；最终状态通过校验后与业务写入共同进入事务/outbox。
   */
  readonly emits: readonly EmitSpec[];
  /**
   * handler 前依次执行的硬约束，拒绝会回滚命令事务；与最终不变量检查职责不同。
   */
  readonly constraints: readonly Constraint<A>[];
  /**
   * 规范化调用入口列表，默认 [user]；仍需能力和数据范围检查，不能把被流程选中当作授权。
   */
  readonly invokedBy: readonly Invoker[];
  /** 显式公开命令，默认 false；允许 anonymous 主体并跳过能力点检查，但不跳过调用身份、范围、状态、版本及业务约束。 */
  readonly public: boolean;
  /** 显式命令名；不写时取导出名 */
  readonly name?: string;
  /**
   * 可选命令用途说明，供目录、本体和生成文档展示，不改变能力名称或执行策略。
   */
  readonly description?: string;
  /**
   * 在框架草稿、已解析输入和已声明只读依赖上描述业务字段变化。
   * 可返回草稿、字段补丁、void 或 DomainError；状态/版本由流水线维护，外部 IO 应走连接器，不由此回调自行提交数据库事务。
   */
  readonly handler: (o: Draft<A>, input: z.output<I>, deps: DepsOf<R>, ctx: HandlerCtx) => MaybePromise<HandlerResult<A>>;
}

/**
 * 注册表中的命令可以有不同聚合、输入与 reads，因此这里擦除具体泛型。
 * 不能用 Command<AnyAggregate, Reads, ZodType>：函数参数逆变会要求业务
 * handler 接受任意聚合，导致带 stock 等明确读依赖的命令无法传给 approval。
 * command() 的返回值仍保留 A/R/I，调用处的类型推导不受这个内部容器类型影响。
 */
export type AnyCommand = Omit<Command<AnyAggregate, Reads, z.ZodType>, 'handler'> & {
  /** 注册表内部擦除 handler 参数类型以容纳不同聚合/reads；业务 command 返回类型仍精确保留输入与依赖。 */
  readonly handler: (...args: any[]) => MaybePromise<any>;
};

/**
 * 已有对象命令省略 input 时使用的默认 schema，只接收 UUID id；expectedVersion 由流水线作为并发元数据单独拆分。
 */
export const idOnly = z.object({ id: z.string().uuid() });
/**
 * 新建命令省略 input 时使用的默认空对象 schema；需要业务参数时应显式声明，聚合字段不会自动成为命令输入。
 */
export const empty = z.object({});

/**
 * 根据 from 是否为 new 推导省略 input 时的 schema，新建为空对象、已有对象默认 idOnly。
 */
type DefaultInput<F> = F extends 'new' ? typeof empty : typeof idOnly;

/**
 * 应用传给 command 的原始声明选项，保留 from 与输入/读依赖泛型推导。
 * 构造时规范化默认值和冻结容器；后续注册与执行仍检查跨声明关系、输入、授权和业务状态，不能把成功构造当作可执行证明。
 */
export interface CommandDef<A extends AnyAggregate, R extends Reads, I extends z.ZodType, F> {
  /** 起始状态；'new' 表示新建 */
  from: F;
  /** 目标状态；非新建命令可显式写 null，只更新业务字段而不迁移状态。 */
  to: F extends 'new' ? StateOf<A> : StateOf<A> | null;
  /** 输入校验，handler 收到解析后的值；省略时新建为 {}、已有记录为 { id: uuid }，已有记录显式 schema 必须提供 id。 */
  input?: I;
  /** 别名到聚合的只读依赖，默认空；handler 只获得这些仓储，运行时访问未声明别名会报 CAGE-READS-001。 */
  reads?: R;
  /** 默认空；可传事件声明或 emit 显式映射，载荷在最终快照形成后校验，并与命令写入同事务保存。 */
  emits?: (AnyEvent | EmitSpec)[];
  /** 默认空；handler 前按声明顺序执行的硬约束，拒绝或异常中止整笔命令，不代替最终不变量。 */
  constraints?: NoInfer<Constraint<A>>[];
  /** 谁能调用，默认 user */
  invokedBy?: Invoker | Invoker[];
  /**
   * 默认 false；true 允许显式匿名主体且跳过该命令能力检查，仍受调用身份、状态、范围、版本及业务约束限制，不能用于普通业务提权。
   */
  public?: boolean;
  /**
   * 可选小驼峰命令名；省略时由顶层导出名推导，能力最终为 Aggregate.commandName。
   */
  name?: string;
  /**
   * 面向能力目录和本体的业务说明，应写操作意图及边界，不承担运行时约束。
   */
  description?: string;
  /**
   * 用可写业务草稿、解析后输入及受限读依赖描述业务变化，可同步或异步返回草稿、补丁、void 或 DomainError。
   * 允许等待声明的只读依赖；状态/系统列由内核维护，外部副作用应声明连接器和事件，不在 handler 自行开连接或提交事务。
   */
  handler: (
    o: Draft<A>,
    input: z.output<[I] extends [never] ? DefaultInput<F> : I>,
    deps: DepsOf<R>,
    ctx: HandlerCtx,
  ) => MaybePromise<HandlerResult<A>>;
}

/**
 * 构造命令描述，不执行业务，也不注册全局状态。新建默认空输入，更新默认只要求 id。
 * from/to 必须属于聚合状态；更新可用 to:null 保留当前状态，新建必须指定真实目标状态。
 * 命令名称可显式给出，也可稍后从 domain 导出名推断，因此仅写文件还不足以注册能力。
 */
export function command<
  A extends AnyAggregate,
  const F extends StateOf<A> | readonly StateOf<A>[] | 'new',
  R extends Reads = {},
  I extends z.ZodType = never,
>(agg: A, def: CommandDef<A, R, I, F>): Command<A, R, [I] extends [never] ? DefaultInput<F> : I> {
  const from = def.from as unknown as string | string[];
  if (from !== 'new' && !hasStates(agg, from)) {
    throw declError('CAGE-STATE-001', `${agg.name} 的命令 from 里有未声明的状态：${[from].flat().join(', ')}`);
  }
  // 回执等异步元数据可能在单据取消/完成后到达。允许显式保留当前状态，
  // 避免业务 handler 通过篡改 status 绕过状态机；新建命令必须有实际目标状态。
  if (from === 'new' && def.to === null) {
    throw declError('CAGE-CMD-003', `${agg.name} 的新建命令必须指定目标状态，不能使用 to: null`);
  }
  if (def.to !== null && !hasStates(agg, def.to as string)) {
    throw declError('CAGE-STATE-001', `${agg.name} 的命令 to 是未声明的状态：${String(def.to)}`);
  }
  const input = (def.input ?? (from === 'new' ? empty : idOnly)) as z.ZodType;
  if (from !== 'new' && input instanceof z.ZodObject && !('id' in input.shape)) {
    throw declError('CAGE-CMD-002', `${agg.name} 的非新建命令输入必须包含 id`);
  }
  if (def.name !== undefined && !/^[a-z][A-Za-z0-9]*$/.test(def.name)) {
    throw declError('CAGE-NAME-004', `命令名 ${def.name} 必须是小驼峰`);
  }
  return Object.freeze({
    [COMMAND]: true as const,
    agg,
    from: (from === 'new' ? 'new' : Object.freeze([from].flat())) as any,
    to: def.to,
    input: input as any,
    reads: Object.freeze({ ...(def.reads ?? {}) }) as R,
    emits: Object.freeze((def.emits ?? []).map(toEmitSpec)),
    constraints: Object.freeze([...(def.constraints ?? [])]),
    invokedBy: Object.freeze([def.invokedBy ?? 'user'].flat()),
    public: def.public ?? false,
    name: def.name,
    description: def.description,
    handler: def.handler as any,
  });
}

/** 注册表识别顶层导出时使用；具体结构和跨声明关系由后续注册校验负责。 */
export function isCommand(v: unknown): v is AnyCommand {
  return !!v && typeof v === 'object' && (v as any)[COMMAND] === true;
}
