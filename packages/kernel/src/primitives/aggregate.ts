/**
 * 声明业务对象的字段、生命周期、范围元数据和最终不变量，并派生快照类型。
 * 注册表、DDL、契约、安全读和写流水线共同消费同一规格；聚合描述不持有记录或连接，数据变化必须经所属命令完成。
 */
// aggregate 原语：一个业务实体的全部规则。调用它不连数据库、不注册全局状态，只返回冻结的描述对象。
import { z } from 'zod';
import { AGGREGATE } from '../brands.js';
import { declError } from '../errors.js';
import type { ScopeSpec } from '../scope/index.js';
import { snake } from '../util/names.js';
import { type AnyField, type FieldValues, type Fields, isField, isRelation, isFile, objectSchema } from './fields.js';
import { DEFAULT_STATES, isStates, type StatesDef } from './states.js';

/** 每张表都有的系统列 */
/** 系统列由写流水线维护；时间对外统一为字符串，version 用于乐观并发检查。 */
export interface SystemCols<S extends string> {
  /**
   * 对象 UUID，由新建流水线生成或按受控规则采用输入，后续 handler 不能改写。
   */
  id: string;
  /**
   * 持久记录的乐观并发版本；新记录提交后为 1，成功更新递增，客户端可提交 expectedVersion 检测冲突。
   */
  version: number;
  /**
   * 当前生命周期状态，类型来自声明 states；由命令 to 确定，handler 不直接迁移。
   */
  status: S;
  /**
   * 对象创建 UTC 时间字符串，更新时保持原创建时间。
   */
  createdAt: string;
  /**
   * 最近成功写入时间字符串，同一命令使用固定时间。
   */
  updatedAt: string;
}

/**
 * 聚合字段值与系统列的组合类型；用于持久记录和业务规则输入。
 * 不含租户内部列，hasMany 不在可写字段集合中；是否已做范围/掩码应以具体读入口为准，类型本身不证明授权。
 */
export type Snapshot<F extends Fields = Fields, S extends string = string> = FieldValues<F> & SystemCols<S>;

/**
 * 由内核维护的字段名白名单，禁止重复声明业务列；status 可用专门 StatesDef 语法声明生命周期，但不能伪装普通字段。
 */
export const RESERVED_FIELDS = ['id', 'version', 'status', 'createdAt', 'updatedAt', 'tenantId'] as const;

/** 注册、DDL、契约和读写流水线共享的对象规格；声明对象本身不持有数据或数据库连接。 */
export interface Aggregate<N extends string = string, F extends Fields = Fields, S extends string = string> {
  /**
   * 聚合品牌标记，供注册表与类型守卫识别，不触发注册副作用。
   */
  readonly [AGGREGATE]: true;
  /** 聚合名，同时是表名和能力点前缀 */
  readonly name: N;
  /**
   * 冻结的业务字段定义映射，状态声明已移出，系统保留列由内核补充。
   */
  readonly fields: F;
  /**
   * 规范化生命周期定义；未显式声明时为 active/deleted，不自动生成 CRUD 命令。
   */
  readonly states: StatesDef<S>;
  /**
   * 部门/所有者等范围字段元数据；真实可见范围来自当前角色 grants，声明不授予权限。
   */
  readonly scope: ScopeSpec;
  /**
   * 按名称定义的最终快照布尔检查，在字段合并与目标状态确定后逐项验证；任一 false 拒绝整笔命令事务。
   */
  readonly invariants: Readonly<Record<string, (o: Snapshot<F, S>) => boolean>>;
  /** 由 fields 拼出的整体校验 */
  readonly schema: z.ZodObject<any>;
  /**
   * 物理表定位：schema 默认 core，name 默认聚合名 snake_case；sys 用于框架组织和运行聚合。
   */
  readonly table: { /** 物理命名空间，普通业务为 core，框架内部组织对象可为 sys。 */ readonly schema: 'core' | 'sys'; /** 已解析的物理表名，默认聚合名称 snake_case，不是显示标题。 */ readonly name: string };
  /**
   * 聚合业务含义说明，供本体和文档展示，不自动成为数据库约束。
   */
  readonly description?: string;
  /** 内部选项：授权类聚合写入后通知各实例清缓存 */
  readonly options: { /** 授权对象变更后的缓存通知范围：self 通知本次对象 ID，all 通知所有授权缓存。 */ readonly grants?: 'self' | 'all' };
}

/**
 * 注册表等异构容器中的聚合擦除类型，保留声明结构而不保留具体字段/状态推导；业务声明应保留 aggregate 返回的精确类型。
 */
export type AnyAggregate = Aggregate<string, any, any>;
/**
 * 从聚合类型提取状态字符串联合；非聚合得到 never，不检查某个命令实际可达性。
 */
export type StateOf<A> = A extends Aggregate<any, any, infer S> ? S : never;
/**
 * 提取聚合原始 Field 映射，用于路由字段、生成器与类型约束；不是数据库行值。
 */
export type FieldsOf<A> = A extends Aggregate<any, infer F, any> ? F : never;
/**
 * 提取特定聚合字段值与系统列的完整快照类型，保留该聚合状态联合。
 */
export type SnapshotOf<A> = A extends Aggregate<any, infer F, infer S> ? Snapshot<F, S> : never;
/**
 * 提取聚合可写业务字段值，不含内核系统列及只读 hasMany 反向集合。
 */
export type FieldValuesOf<A> = A extends Aggregate<any, infer F, any> ? FieldValues<F> : never;

/**
 * aggregate 输入字段容器，允许普通字段和仅可放在 status 键上的状态声明；位置规则在构造时校验。
 */
type FieldInput = Record<string, AnyField | StatesDef<any>>;
/**
 * 从输入字段类型移除 StatesDef，得到真正的业务 Field 映射；状态另放入系统列类型。
 */
type PlainFields<FI> = { [K in keyof FI as FI[K] extends StatesDef<any> ? never : K]: FI[K] extends AnyField ? FI[K] : never };
/**
 * 收集 fields 内 StatesDef 的状态联合，供与顶层 states 选项统一推导；运行时仍禁止重复声明状态集。
 */
type StatesIn<FI> = { [K in keyof FI]: FI[K] extends StatesDef<infer S> ? S : never }[keyof FI];
/**
 * 优先使用显式顶层状态类型，否则使用 fields.status，均未声明时推导 active/deleted 默认生命周期。
 */
type ResolveStates<FI, SS extends string> = [SS] extends [never]
  ? ([StatesIn<FI>] extends [never] ? 'active' | 'deleted' : StatesIn<FI>)
  : SS;

/**
 * 应用提供的聚合声明输入。
 * 字段、状态、范围与不变量统一在构造时验证和冻结；table/options 面向框架内部扩展，普通业务默认写入 core 下聚合对应表。
 */
export interface AggregateDef<FI extends FieldInput, SS extends string> {
  /**
   * 业务字段定义；可用 status: StatesDef 声明状态，但不能同时提供顶层 states，也不能重定义其他系统列。
   */
  fields: FI;
  /** 状态集；也可以写在 fields 里：status: POStatus */
  states?: StatesDef<SS>;
  /** 数据范围：哪个字段是部门、哪个是创建人 */
  scope?: ScopeSpec;
  /** 不变量：普通函数，每次写入后逐条校验 */
  invariants?: Record<string, (o: Snapshot<PlainFields<FI>, ResolveStates<FI, SS>>) => boolean>;
  /**
   * 可选中文对象职责说明，帮助目录与 agent 识别业务含义；不影响聚合标识。
   */
  description?: string;
  /** 框架内部使用：系统聚合放在 sys 模式 */
  table?: { /** 内部表命名空间覆盖，省略时 core，不用于普通业务绕过安全读。 */ schema?: 'core' | 'sys'; /** 内部物理表名覆盖，省略时由聚合名转 snake_case。 */ name?: string };
  /** 框架内部使用 */
  options?: { /** 框架授权类聚合提交后的失效通知：self 为当前记录 ID，all 为通配通知；省略时不触发此专用机制。 */ grants?: 'self' | 'all' };
}

/**
 * 校验并冻结聚合规格，统一解析 states 与 fields.status 两种写法，拒绝二义性。
 * 未指定状态时使用默认生命周期；createdBy 自动参与本人范围，其他范围字段必须真实存在。
 * 声明错误立即抛出 CageDeclarationError；数据库建表和实际授权在后续阶段完成。
 */
export function aggregate<const N extends string, FI extends FieldInput, SS extends string = never>(
  name: N,
  def: AggregateDef<FI, SS>,
): Aggregate<N, PlainFields<FI>, ResolveStates<FI, SS>> {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    throw declError('CAGE-NAME-001', `聚合名 ${name} 必须是大驼峰`);
  }
  let st: StatesDef<any> | undefined = def.states;
  const fields: Record<string, AnyField> = {};
  for (const [k, v] of Object.entries(def.fields)) {
    if (isStates(v)) {
      if (k !== 'status') throw declError('CAGE-STATE-005', `状态集只能放在 status 字段上（发现 ${name}.${k}）`);
      if (st) throw declError('CAGE-STATE-005', `${name} 同时在 states 和 fields.status 里声明了状态`);
      st = v;
      continue;
    }
    if (!isField(v)) throw declError('CAGE-FIELD-003', `${name}.${k} 不是字段原语`);
    if ((RESERVED_FIELDS as readonly string[]).includes(k)) {
      throw declError('CAGE-FIELD-004', `${name}.${k} 是保留字段名，由内核维护`);
    }
    if (!/^[a-z][A-Za-z0-9]*$/.test(k)) throw declError('CAGE-NAME-002', `字段名 ${name}.${k} 必须是小驼峰`);
    fields[k] = v;
  }
  const states = st ?? DEFAULT_STATES;

  // 范围：未写创建人字段时，自动识别 createdBy
  const sc: ScopeSpec = def.scope ?? {};
  const ownerField = sc.ownerField ?? ('createdBy' in fields ? 'createdBy' : undefined);
  for (const f of [sc.deptField, ownerField]) {
    if (f && f !== 'id' && !(f in fields)) throw declError('CAGE-SCOPE-002', `${name} 的范围字段 ${f} 不存在`);
    if (f && f !== 'id' && isRelation(fields[f])) throw declError('CAGE-REL-001', `${name} 的范围字段必须是主表列，不能使用集合关系 ${f}`);
    if (f && f !== 'id' && isFile(fields[f])) throw declError('CAGE-FILE-001', `${name} 的范围字段不能使用文件 ${f}`);
  }
  const scope: ScopeSpec = Object.freeze({ ...sc, ownerField });

  return Object.freeze({
    [AGGREGATE]: true as const,
    name,
    fields: Object.freeze(fields) as any,
    states,
    scope,
    invariants: Object.freeze({ ...(def.invariants ?? {}) }) as any,
    schema: objectSchema(fields),
    table: Object.freeze({ schema: def.table?.schema ?? 'core', name: def.table?.name ?? snake(name) }),
    description: def.description,
    options: Object.freeze({ ...(def.options ?? {}) }),
  });
}

/** 按品牌标记识别声明；不依赖 instanceof，因此支持模块副本和 re-export。 */
export function isAggregate(v: unknown): v is AnyAggregate {
  return !!v && typeof v === 'object' && (v as any)[AGGREGATE] === true;
}

/** 检查全部候选状态是否已声明；不判断迁移可达性或当前记录能否执行某个命令。 */
export function hasStates(agg: AnyAggregate, s: string | readonly string[]): boolean {
  return [s].flat().every((x) => agg.states.values.includes(x));
}

/** 聚合中不对外暴露（hidden）的字段名 */
export function hiddenFields(agg: AnyAggregate): string[] {
  return Object.entries(agg.fields as Fields).filter(([, f]) => f.isHidden).map(([k]) => k);
}

/** 聚合中的敏感字段：字段名 → 种类 */
export function sensitiveFields(agg: AnyAggregate): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agg.fields as Fields).filter(([, f]) => f.sensitiveKind).map(([k, f]) => [k, f.sensitiveKind!]),
  );
}
