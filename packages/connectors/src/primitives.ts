// 连接器原语：声明对方系统的地址白名单、密钥名、操作清单和调用策略；AI 只写两头的映射函数。
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CONNECTOR, CONSUMERS, INBOUND, OUTBOUND, declError, type AnyCommand, type AnyEvent, type Kernel, type PayloadOf,
} from '@yss123/cage-kernel';
import type { EventConsumer } from '@yss123/cage-kernel/worker';
import { z } from 'zod';
import { outboundConsumer } from './runtime.js';

/** 副作用等级：read 只读；retryableWrite 可重试写（对方按幂等键去重）；write 不可重试写（失败直接进死信，人工处理） */
export type Effect = 'read' | 'retryableWrite' | 'write';

/** 声明单次外部协议；effect 必须反映远端真实幂等保证，不能仅为方便重试而标 retryableWrite。 */
export interface OpDef<Req extends z.ZodObject<any> = z.ZodObject<any>, Res extends z.ZodType = z.ZodType> {
  effect: Effect;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** 出站字段白名单：只允许发这些字段 */
  request: Req;
  /** 对方返回的格式：响应也按声明校验，对方格式变了立即发现 */
  response: Res;
}

export interface Op<Req extends z.ZodObject<any> = z.ZodObject<any>, Res extends z.ZodType = z.ZodType> extends OpDef<Req, Res> {
  readonly name: string;
  readonly connector: Connector;
}

/** 保存操作规格并检查绝对路径形式；此时没有连接器环境/密钥，也不会发出请求。 */
export function op<Req extends z.ZodObject<any>, Res extends z.ZodType>(def: OpDef<Req, Res>): OpDef<Req, Res> {
  if (!def.path.startsWith('/')) throw declError('CAGE-CONN-002', `操作路径 ${def.path} 必须以 / 开头`);
  return def;
}

/** 外部系统的固定边界；hosts 按运行阶段选择，密钥仅声明名字，超时毫秒、限流每秒请求数。 */
export interface ConnectorDef<Ops extends Record<string, OpDef<any, any>>> {
  /** 地址白名单：按环境各一个，代码里写不了任意地址 */
  hosts: { test?: string; prod?: string; [stage: string]: string | undefined };
  /** 只写密钥名，值由密钥管理服务（或环境变量）注入 */
  secret?: string;
  timeoutMs?: number;
  retry?: { max: number; backoff: 'exponential' | 'fixed' };
  rateLimit?: { perSecond: number };
  operations: Ops;
}

export interface Connector<Ops extends Record<string, OpDef<any, any>> = Record<string, OpDef<any, any>>> {
  readonly [CONNECTOR]: true;
  readonly name: string;
  readonly hosts: ConnectorDef<Ops>['hosts'];
  readonly secret?: string;
  readonly timeoutMs: number;
  readonly retry: { max: number; backoff: 'exponential' | 'fixed' };
  readonly rateLimit?: { perSecond: number };
  readonly operations: { readonly [K in keyof Ops]: Op<Ops[K]['request'], Ops[K]['response']> };
}

/**
 * 校验名称、超时、限流与主机形式，冻结操作并回链到所属连接器。
 * hosts 不含路径/协议，运行时按阶段选择；构造不读取密钥或访问网络，便于静态抽取与离线检查。
 */
export function connector<Ops extends Record<string, OpDef<any, any>>>(name: string, def: ConnectorDef<Ops>): Connector<Ops> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw declError('CAGE-CONN-001', `连接器名 ${name} 必须是小写短横线`);
  if (def.timeoutMs !== undefined && (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs <= 0 || def.timeoutMs > 300_000)) {
    throw declError('CAGE-CONN-015', '连接器 timeoutMs 必须是 1～300000 毫秒的整数');
  }
  if (def.rateLimit && (!Number.isFinite(def.rateLimit.perSecond) || def.rateLimit.perSecond <= 0)) {
    throw declError('CAGE-CONN-015', '连接器 rateLimit.perSecond 必须为有限正数');
  }
  for (const h of Object.values(def.hosts)) {
    if (h && /[/:\s]/.test(h.replace(/:\d+$/, ''))) throw declError('CAGE-CONN-003', `地址白名单只能写主机名（可带端口）：${h}`);
  }
  const c: any = {
    [CONNECTOR]: true,
    name,
    hosts: Object.freeze({ ...def.hosts }),
    secret: def.secret,
    timeoutMs: def.timeoutMs ?? 5000,
    retry: def.retry ?? { max: 5, backoff: 'exponential' },
    rateLimit: def.rateLimit,
  };
  c.operations = Object.freeze(Object.fromEntries(Object.entries(def.operations).map(([k, o]) => [k, Object.freeze({ ...o, name: k, connector: c })])));
  return Object.freeze(c);
}

// ---------------- 出站映射 ----------------

export interface Outbound<E extends AnyEvent = AnyEvent, O extends Op = Op> {
  readonly [OUTBOUND]: true;
  readonly event: E;
  readonly op: O;
  readonly idempotencyKey: (e: PayloadOf<E>) => string;
  /** 出站映射：我们的事件转成对方请求（纯函数）；返回 null 表示这次不推 */
  readonly map: (e: PayloadOf<E>) => z.input<O['request']> | null;
  /** 成功后怎么回写：通过命令回写，而不是直接改表 */
  readonly onSuccess?: { command: AnyCommand; map: (res: z.output<O['response']>, e: PayloadOf<E>) => unknown };
  /** 映射用到的事件字段，进入本体图 */
  readonly fields?: readonly string[];
  readonly [CONSUMERS]: (k: Kernel) => EventConsumer[];
}

/**
 * 把领域事件映射为事务外写操作；只读操作不允许挂出站，成功回写必须指向领域命令。
 * map 返回 null 可跳过当前事件，幂等键需要跨重投稳定；消费器由 CONSUMERS 在 worker 装配。
 */
export function outbound<E extends AnyEvent, O extends Op>(
  ev: E,
  operation: O,
  def: {
    idempotencyKey: (e: PayloadOf<E>) => string;
    map: (e: PayloadOf<E>) => z.input<O['request']> | null;
    onSuccess?: { command: AnyCommand; map: (res: z.output<O['response']>, e: PayloadOf<E>) => unknown };
    fields?: string[];
  },
): Outbound<E, O> {
  if (operation.effect === 'read') throw declError('CAGE-CONN-004', '只读操作不能用于出站映射');
  const o: any = {
    [OUTBOUND]: true,
    event: ev,
    op: operation,
    idempotencyKey: def.idempotencyKey,
    map: def.map,
    onSuccess: def.onSuccess,
    fields: def.fields ?? Object.keys(ev.fields),
  };
  o[CONSUMERS] = (k: Kernel) => [outboundConsumer(k, o)];
  return Object.freeze(o);
}

// ---------------- 入站回调 ----------------

/** 入站原始字节验签协议；secret 是注入名称，verify 不解析业务载荷或决定其领域权限。 */
export interface Verifier {
  readonly kind: string;
  readonly secret: string;
  verify(rawBody: string, headers: Record<string, string | string[] | undefined>, secretValue: string): boolean;
}

/** HMAC-SHA256 验签：签名放在请求头（默认 x-signature），值为 hex 或 sha256=hex */
/** 签名基于原始正文计算，接受 hex 或 sha256=hex；长度校验后恒定时间比较，不能对解析后 JSON 重算。 */
export function hmacSha256(secret: string, opts: { header?: string } = {}): Verifier {
  const header = (opts.header ?? 'x-signature').toLowerCase();
  return Object.freeze({
    kind: 'hmac-sha256',
    secret,
    verify(rawBody: string, headers: Record<string, string | string[] | undefined>, secretValue: string) {
      const got = String(headers[header] ?? '').replace(/^sha256=/, '');
      if (!/^[0-9a-f]{64}$/i.test(got)) return false;
      const want = createHmac('sha256', secretValue).update(rawBody).digest('hex');
      return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
    },
  });
}

export interface Inbound<P extends z.ZodType = z.ZodType> {
  readonly [INBOUND]: true;
  readonly connector: Connector<any>;
  /** 事件名，生成路由 POST /hooks/{connector}/{event-kebab} */
  readonly event: string;
  readonly verify: Verifier;
  readonly payload: P;
  /** 映射到的命令，以 external 身份调用 */
  readonly command: AnyCommand;
  readonly map: (p: z.output<P>) => unknown;
}

/**
 * 声明验签后的回调映射，HTTP 适配器校验载荷后以 external 身份执行目标命令。
 * 事件名决定自动路由；这里不注册服务器，也不因签名通过而绕过命令状态、版本或业务约束。
 */
export function inbound<P extends z.ZodType>(
  conn: Connector<any>,
  eventName: string,
  def: { verify: Verifier; payload: P; command: AnyCommand; map: (p: z.output<P>) => unknown },
): Inbound<P> {
  if (!/^[a-z][A-Za-z0-9]*$/.test(eventName)) throw declError('CAGE-CONN-005', `入站事件名 ${eventName} 必须是小驼峰`);
  if (!def.command.invokedBy.includes('external') && !def.command.invokedBy.includes('user')) {
    throw declError('CAGE-CONN-006', `入站回调调用的命令必须声明 invokedBy: 'external'`);
  }
  return Object.freeze({ [INBOUND]: true as const, connector: conn, event: eventName, ...def });
}
