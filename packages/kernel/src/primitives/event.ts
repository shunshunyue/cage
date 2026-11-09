/**
 * 定义领域事件及从命令前后快照构造载荷的映射规格。
 * 命令流水线校验载荷并与业务写入同事务保存 outbox，再交给同事务反应或异步消费者；声明函数本身不会投递消息，也不保证第三方恰好一次收到。
 */
// event 原语：事件名 + 载荷 schema。命令发出的事件与业务写入同事务写入 outbox。
import { z } from 'zod';
import { EVENT } from '../brands.js';
import { declError } from '../errors.js';
import { type FieldValues, type Fields, isRelation, isFile, objectSchema } from './fields.js';

/** 事件描述已发生的事实；字段是稳定传输载荷，不是聚合表结构或关联集合声明。 */
export interface Event<N extends string = string, F extends Fields = Fields> {
  /**
   * 事件品牌标记，供注册表与 emits 归一化识别。
   */
  readonly [EVENT]: true;
  /**
   * 稳定大驼峰事件名，作为持久 outbox 和消费者协议标识，已部署后修改含义需考虑兼容。
   */
  readonly name: N;
  /**
   * 冻结载荷字段映射，不是持久聚合表；禁止集合关系和文件生命周期原语，关联使用 ID 值传递。
   */
  readonly fields: F;
  /**
   * 由字段生成的载荷校验器，在事件持久化前验证必填、类型和可空规则。
   */
  readonly schema: z.ZodObject<any>;
  /**
   * 可选事实含义说明，供目录和本体展示，不改变投递或事务行为。
   */
  readonly description?: string;
}

/**
 * 不同事件名称/字段的异构容器类型，用于命令 emits、反应和注册表；事件声明返回值仍保留载荷字段类型。
 */
export type AnyEvent = Event<string, any>;
/**
 * 从事件 Field 映射推导载荷业务值，不添加对象系统列；需要对象 ID 或旧状态时必须在事件 fields 中显式声明。
 */
export type PayloadOf<E> = E extends Event<any, infer F> ? FieldValues<F> : never;

/**
 * 声明事件名称与严格字段规格；拒绝关系/文件生命周期原语，引用对象时应发送 ID。
 * 此函数不投递事件；只有命令流水线完成载荷映射、校验并写入 outbox 后才形成事件事实。
 */
export function event<const N extends string, F extends Fields>(name: N, fields: F, opts?: { /** 可选事件事实说明，供本体与文档使用；不改变事件名、字段或投递语义。 */ description?: string }): Event<N, F> {
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

/** 区分裸事件声明与 emit 映射对象，避免构造命令时丢失显式载荷映射。 */
export function isEvent(v: unknown): v is AnyEvent {
  return !!v && typeof v === 'object' && (v as any)[EVENT] === true;
}

/** 显式指定载荷怎么从快照得到：emits: [emit(OrderApproved, (o) => ({ orderId: o.id, items: o.items }))] */
export interface EmitSpec<E extends AnyEvent = AnyEvent> {
  /**
   * 待发出的事件声明，决定载荷 schema 和后续反应订阅。
   */
  readonly event: E;
  /** snapshot：写入后的快照；input：命令输入；previous：写入前的快照（新建时为 null） */
  readonly map?: (snapshot: any, input: any, previous: any) => PayloadOf<E>;
}

/** 保存纯映射回调；previous 对新建为 null，可用于取消等需要旧状态决定资源释放的事件。 */
export function emit<E extends AnyEvent>(ev: E, map: (snapshot: any, input: any, previous: any) => PayloadOf<E>): EmitSpec<E> {
  return Object.freeze({ event: ev, map });
}

/** 将两种 emits 写法归一化；裸事件留空 map，在执行时使用 defaultPayload。 */
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
