// event 原语：事件名 + 载荷 schema。命令发出的事件与业务写入同事务写入 outbox。
import { z } from 'zod';
import { EVENT } from '../brands.js';
import { declError } from '../errors.js';
import { type FieldValues, type Fields, isRelation, isFile, objectSchema } from './fields.js';

export interface Event<N extends string = string, F extends Fields = Fields> {
  readonly [EVENT]: true;
  readonly name: N;
  readonly fields: F;
  readonly schema: z.ZodObject<any>;
  readonly description?: string;
}

export type AnyEvent = Event<string, any>;
export type PayloadOf<E> = E extends Event<any, infer F> ? FieldValues<F> : never;

export function event<const N extends string, F extends Fields>(name: N, fields: F, opts?: { description?: string }): Event<N, F> {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-003', `事件名 ${name} 必须是大驼峰`);
  if (Object.values(fields).some(isRelation)) throw declError('CAGE-REL-001', '事件载荷不声明持久化关系；传递 ID 数组请使用 list(id())');
  if (Object.values(fields).some(isFile)) throw declError('CAGE-FILE-001', '事件传递文件 ID 请使用 id/list(id())，不声明文件生命周期');
  return Object.freeze({
    [EVENT]: true as const,
    name,
    fields: Object.freeze({ ...fields }),
    schema: objectSchema(fields),
    description: opts?.description,
  });
}

export function isEvent(v: unknown): v is AnyEvent {
  return !!v && typeof v === 'object' && (v as any)[EVENT] === true;
}

/** 显式指定载荷怎么从快照得到：emits: [emit(OrderApproved, (o) => ({ orderId: o.id, items: o.items }))] */
export interface EmitSpec<E extends AnyEvent = AnyEvent> {
  readonly event: E;
  /** snapshot：写入后的快照；input：命令输入；previous：写入前的快照（新建时为 null） */
  readonly map?: (snapshot: any, input: any, previous: any) => PayloadOf<E>;
}

export function emit<E extends AnyEvent>(ev: E, map: (snapshot: any, input: any, previous: any) => PayloadOf<E>): EmitSpec<E> {
  return Object.freeze({ event: ev, map });
}

export function toEmitSpec(e: AnyEvent | EmitSpec): EmitSpec {
  return isEvent(e) ? { event: e } : e;
}

/**
 * 默认载荷映射规则（没有写 emit(...) 时）：
 *   1. 载荷字段名在快照里存在 → 取快照的值
 *   2. 载荷字段名以 Id 结尾、快照里没有同名字段 → 取聚合自己的 id（例如 orderId）
 *   3. 其他 → 取命令输入里的同名值
 */
export function defaultPayload(ev: AnyEvent, snapshot: Record<string, unknown>, input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(ev.fields)) {
    if (k in snapshot) out[k] = snapshot[k];
    else if (k.endsWith('Id')) out[k] = snapshot.id;
    else if (input && k in input) out[k] = input[k];
  }
  return out;
}
