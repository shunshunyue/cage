// aggregate 原语：一个业务实体的全部规则。调用它不连数据库、不注册全局状态，只返回冻结的描述对象。
import { z } from 'zod';
import { AGGREGATE } from '../brands.js';
import { declError } from '../errors.js';
import type { ScopeSpec } from '../scope/index.js';
import { snake } from '../util/names.js';
import { type AnyField, type FieldValues, type Fields, isField, objectSchema } from './fields.js';
import { DEFAULT_STATES, isStates, type StatesDef } from './states.js';

/** 每张表都有的系统列 */
export interface SystemCols<S extends string> {
  id: string;
  version: number;
  status: S;
  createdAt: string;
  updatedAt: string;
}

export type Snapshot<F extends Fields = Fields, S extends string = string> = FieldValues<F> & SystemCols<S>;

export const RESERVED_FIELDS = ['id', 'version', 'status', 'createdAt', 'updatedAt', 'tenantId'] as const;

export interface Aggregate<N extends string = string, F extends Fields = Fields, S extends string = string> {
  readonly [AGGREGATE]: true;
  /** 聚合名，同时是表名和能力点前缀 */
  readonly name: N;
  readonly fields: F;
  readonly states: StatesDef<S>;
  readonly scope: ScopeSpec;
  readonly invariants: Readonly<Record<string, (o: Snapshot<F, S>) => boolean>>;
  /** 由 fields 拼出的整体校验 */
  readonly schema: z.ZodObject<any>;
  readonly table: { readonly schema: 'core' | 'sys'; readonly name: string };
  readonly description?: string;
  /** 内部选项：授权类聚合写入后通知各实例清缓存 */
  readonly options: { readonly grants?: 'self' | 'all' };
}

export type AnyAggregate = Aggregate<string, any, any>;
export type StateOf<A> = A extends Aggregate<any, any, infer S> ? S : never;
export type FieldsOf<A> = A extends Aggregate<any, infer F, any> ? F : never;
export type SnapshotOf<A> = A extends Aggregate<any, infer F, infer S> ? Snapshot<F, S> : never;
export type FieldValuesOf<A> = A extends Aggregate<any, infer F, any> ? FieldValues<F> : never;

type FieldInput = Record<string, AnyField | StatesDef<any>>;
type PlainFields<FI> = { [K in keyof FI as FI[K] extends StatesDef<any> ? never : K]: FI[K] extends AnyField ? FI[K] : never };
type StatesIn<FI> = { [K in keyof FI]: FI[K] extends StatesDef<infer S> ? S : never }[keyof FI];
type ResolveStates<FI, SS extends string> = [SS] extends [never]
  ? ([StatesIn<FI>] extends [never] ? 'active' | 'deleted' : StatesIn<FI>)
  : SS;

export interface AggregateDef<FI extends FieldInput, SS extends string> {
  fields: FI;
  /** 状态集；也可以写在 fields 里：status: POStatus */
  states?: StatesDef<SS>;
  /** 数据范围：哪个字段是部门、哪个是创建人 */
  scope?: ScopeSpec;
  /** 不变量：普通函数，每次写入后逐条校验 */
  invariants?: Record<string, (o: Snapshot<PlainFields<FI>, ResolveStates<FI, SS>>) => boolean>;
  description?: string;
  /** 框架内部使用：系统聚合放在 sys 模式 */
  table?: { schema?: 'core' | 'sys'; name?: string };
  /** 框架内部使用 */
  options?: { grants?: 'self' | 'all' };
}

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

export function isAggregate(v: unknown): v is AnyAggregate {
  return !!v && typeof v === 'object' && (v as any)[AGGREGATE] === true;
}

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
