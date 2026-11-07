// reaction、query、approval、job、unsafe 原语。
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { APPROVAL, JOB, QUERY, REACTION, UNSAFE } from '../brands.js';
import { declError } from '../errors.js';
import type { AnyAggregate, FieldsOf, SnapshotOf } from './aggregate.js';
import type { AnyCommand } from './command.js';
import type { AnyEvent, PayloadOf } from './event.js';

// ---------------- reaction ----------------

export type TxMode = 'outbox' | 'same';

export interface Reaction<E extends AnyEvent = AnyEvent, C extends AnyCommand = AnyCommand> {
  readonly [REACTION]: true;
  readonly event: E;
  readonly command: C;
  /** 作用的聚合（等于 command.agg，写出来便于阅读） */
  readonly target: AnyAggregate;
  /** 把事件载荷映射成命令输入（纯函数）；返回 null 表示这次不处理 */
  readonly map: (e: PayloadOf<E>) => z.input<C['input']> | readonly z.input<C['input']>[] | null;
  /** 同一事件、同一事务模式中的显式步骤序号；启用后各步骤必须完整、唯一地声明。 */
  readonly order?: number;
  /** 有界集合的可检查元数据；集合仍逐项经过命令流水线。 */
  readonly collection?: { readonly maxItems: number; readonly orderBy: string; readonly itemsSource: string; readonly mapSource: string };
  /** 事务语义：outbox 异步（默认，见 D3）；same 与触发命令同一事务 */
  readonly tx: TxMode;
  /** 获得的资源，供资源配对检查使用 */
  readonly acquires?: string;
  /** 释放的资源 */
  readonly releases?: string;
  readonly name?: string;
}

export type AnyReaction = Reaction<AnyEvent, AnyCommand>;

export function reaction<E extends AnyEvent, C extends AnyCommand>(
  ev: E,
  def: {
    command: C;
    map: (e: PayloadOf<E>) => z.input<C['input']> | null;
    target?: AnyAggregate;
    tx?: TxMode;
    acquires?: string;
    releases?: string;
    name?: string;
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

export interface Query<I extends z.ZodType = z.ZodType> {
  readonly [QUERY]: true;
  readonly name: string;
  /** 查询读了哪些聚合：只能引用它们的安全视图；调用者需要每个聚合的 read 能力 */
  readonly reads: readonly AnyAggregate[];
  readonly input: I;
  /** 手写 SQL：只能引用 safe.* 视图，参数用 :name 占位 */
  readonly sql?: string;
  /** 查询构建器写法：db 是只读账号上的 Kysely，只映射安全视图 */
  readonly build?: (db: Kysely<any>, input: z.output<I>) => { execute(): Promise<unknown[]> };
  readonly description?: string;
  /** 用途级可靠审计；敏感明文查询另会自动审计所涉及聚合。 */
  readonly audit?: { readonly purpose: string };
}

export type AnyQuery = Query<z.ZodType>;

export function query<I extends z.ZodType = z.ZodObject<{}>>(
  name: string,
  def: {
    reads: AnyAggregate[];
    input?: I;
    sql?: string;
    build?: (db: Kysely<any>, input: z.output<I>) => { execute(): Promise<unknown[]> };
    description?: string;
    audit?: { purpose: string };
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

export interface Approval<A extends AnyAggregate = AnyAggregate> {
  readonly [APPROVAL]: true;
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
  readonly onRejected: AnyCommand;
  /** 退回修改独立于最终驳回；重新提交会创建新审批轮次。 */
  readonly onReturned?: AnyCommand;
  /** 自动节点使用的角色 code；权限与范围从当前角色授权解析。 */
  readonly automatedBy?: string;
}

export function approval<A extends AnyAggregate>(
  agg: A,
  def: {
    process: string;
    start: AnyEvent;
    cancelOn?: AnyEvent[];
    routable: (keyof FieldsOf<A> & string)[];
    onApproved: AnyCommand;
    onRejected: AnyCommand;
    onReturned?: AnyCommand;
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

export interface JobQueryApi {
  /** 只读查询：等值条件，另支持 createdBefore / createdAfter / updatedBefore */
  list<A extends AnyAggregate>(
    agg: A,
    where?: Partial<SnapshotOf<A>> & { createdBefore?: Date | string; createdAfter?: Date | string; updatedBefore?: Date | string },
    opts?: { limit?: number },
  ): Promise<SnapshotOf<A>[]>;
}

export interface JobApi {
  query: JobQueryApi;
  /** 只能调用 calls 里声明过的命令；每次调用都走完整流水线，审计 source = job */
  call<C extends AnyCommand>(cmd: C, input: z.input<C['input']>): Promise<SnapshotOf<C['agg']>>;
  tenantId: string;
  now: Date;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Job {
  readonly [JOB]: true;
  readonly name: string;
  /** cron 表达式，例如 0 2 * * * */
  readonly cron: string;
  readonly reads: readonly AnyAggregate[];
  readonly calls: readonly AnyCommand[];
  readonly run: (api: JobApi) => Promise<void>;
  readonly description?: string;
}

export function job(
  name: string,
  def: { cron: string; reads?: AnyAggregate[]; calls?: AnyCommand[]; run: (api: JobApi) => Promise<void>; description?: string },
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

/** 前 N 天 */
export function daysAgo(n: number, from = new Date()): Date {
  return new Date(from.getTime() - n * 24 * 3600 * 1000);
}

// ---------------- unsafe ----------------

export interface UnsafeTag {
  readonly reason: string;
  readonly owner: string;
}

/**
 * 逃生口：声明表达不了时使用，必须写明原因和负责人。lint 检查参数，计数进 PR 摘要。
 *   const v = unsafe({ reason: '…', owner: 'zhangsan' }, () => …)
 */
export function unsafe<T>(tag: UnsafeTag, fn: () => T): T {
  if (!tag?.reason || !tag?.owner) throw declError('CAGE-UNSAFE-001', 'unsafe 必须写明 reason 和 owner');
  return fn();
}
(unsafe as any)[UNSAFE] = true;
