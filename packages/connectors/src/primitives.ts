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

export function op<Req extends z.ZodObject<any>, Res extends z.ZodType>(def: OpDef<Req, Res>): OpDef<Req, Res> {
  if (!def.path.startsWith('/')) throw declError('CAGE-CONN-002', `操作路径 ${def.path} 必须以 / 开头`);
  return def;
}

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

export function connector<Ops extends Record<string, OpDef<any, any>>>(name: string, def: ConnectorDef<Ops>): Connector<Ops> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw declError('CAGE-CONN-001', `连接器名 ${name} 必须是小写短横线`);
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

export interface Verifier {
  readonly kind: string;
  readonly secret: string;
  verify(rawBody: string, headers: Record<string, string | string[] | undefined>, secretValue: string): boolean;
}

/** HMAC-SHA256 验签：签名放在请求头（默认 x-signature），值为 hex 或 sha256=hex */
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
