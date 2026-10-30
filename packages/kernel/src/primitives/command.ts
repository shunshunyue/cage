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

export interface FindOptions {
  limit?: number;
  orderBy?: string;
  desc?: boolean;
}

/** 注入给 handler 的只读仓储：自动附加数据范围，范围外等于不存在 */
export interface ReadRepo<A extends AnyAggregate> {
  /** 按 id 取一条，范围外返回 null */
  get(id: string): Promise<SnapshotOf<A> | null>;
  /** 等值条件查询，自动附加范围 */
  find(where?: Partial<SnapshotOf<A>>, opts?: FindOptions): Promise<SnapshotOf<A>[]>;
  /** 按条件取第一条 */
  findOne(where: Partial<SnapshotOf<A>>): Promise<SnapshotOf<A> | null>;
  /** 计数，同样自动附加范围 */
  count(where?: Partial<SnapshotOf<A>>): Promise<number>;
}

export type DepsOf<R extends Reads> = { readonly [K in keyof R]: ReadRepo<R[K]> };

/** handler 拿到的草稿：业务字段可改；状态、主键、版本号只读，handler 改不了 */
export type Draft<A extends AnyAggregate> = FieldValuesOf<A> & {
  readonly id: string;
  readonly status: StateOf<A>;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** handler 的第四个参数：只读的调用信息 */
export interface HandlerCtx {
  /** 当前时间（同一次命令里固定） */
  readonly now: Date;
  /** 真人操作者（系统身份时为它代表的人） */
  readonly actorUserId: string | null;
}

export type HandlerResult<A extends AnyAggregate> = Draft<A> | Partial<FieldValuesOf<A>> | DomainError | void;

export type Invoker = 'user' | 'process' | 'job' | 'external';

export interface Command<
  A extends AnyAggregate = AnyAggregate,
  R extends Reads = Reads,
  I extends z.ZodType = z.ZodType,
> {
  readonly [COMMAND]: true;
  readonly agg: A;
  readonly from: readonly StateOf<A>[] | 'new';
  /** null 表示保持加锁读到的当前状态；仍检查 from、权限、版本并写审计。 */
  readonly to: StateOf<A> | null;
  readonly input: I;
  readonly reads: R;
  readonly emits: readonly EmitSpec[];
  readonly constraints: readonly Constraint<A>[];
  readonly invokedBy: readonly Invoker[];
  /** 匿名用户也能调用（极少使用） */
  readonly public: boolean;
  /** 显式命令名；不写时取导出名 */
  readonly name?: string;
  readonly description?: string;
  readonly handler: (o: Draft<A>, input: z.output<I>, deps: DepsOf<R>, ctx: HandlerCtx) => MaybePromise<HandlerResult<A>>;
}

/**
 * 注册表中的命令可以有不同聚合、输入与 reads，因此这里擦除具体泛型。
 * 不能用 Command<AnyAggregate, Reads, ZodType>：函数参数逆变会要求业务
 * handler 接受任意聚合，导致带 stock 等明确读依赖的命令无法传给 approval。
 * command() 的返回值仍保留 A/R/I，调用处的类型推导不受这个内部容器类型影响。
 */
export type AnyCommand = Omit<Command<AnyAggregate, Reads, z.ZodType>, 'handler'> & {
  readonly handler: (...args: any[]) => MaybePromise<any>;
};

export const idOnly = z.object({ id: z.string().uuid() });
export const empty = z.object({});

type DefaultInput<F> = F extends 'new' ? typeof empty : typeof idOnly;

export interface CommandDef<A extends AnyAggregate, R extends Reads, I extends z.ZodType, F> {
  /** 起始状态；'new' 表示新建 */
  from: F;
  /** 目标状态；非新建命令可显式写 null，只更新业务字段而不迁移状态。 */
  to: F extends 'new' ? StateOf<A> : StateOf<A> | null;
  /** 输入校验；非新建命令的输入必须包含 id */
  input?: I;
  /** 读依赖，决定 handler 能拿到什么 */
  reads?: R;
  /** 发出的事件 */
  emits?: (AnyEvent | EmitSpec)[];
  /** 硬约束组合子 */
  constraints?: NoInfer<Constraint<A>>[];
  /** 谁能调用，默认 user */
  invokedBy?: Invoker | Invoker[];
  public?: boolean;
  name?: string;
  description?: string;
  /** AI 写的业务逻辑：纯函数，返回新草稿、字段变更或业务错误 */
  handler: (
    o: Draft<A>,
    input: z.output<[I] extends [never] ? DefaultInput<F> : I>,
    deps: DepsOf<R>,
    ctx: HandlerCtx,
  ) => MaybePromise<HandlerResult<A>>;
}

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

export function isCommand(v: unknown): v is AnyCommand {
  return !!v && typeof v === 'object' && (v as any)[COMMAND] === true;
}
