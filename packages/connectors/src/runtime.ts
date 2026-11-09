// 连接器运行时：每一道管控都在这里发生——字段白名单、地址白名单、密钥、限流、超时、调用记录、响应校验。
import { systemCtx, type Kernel } from '@yss123/cage-kernel';
import type { EventConsumer, OutboxRow } from '@yss123/cage-kernel/worker';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Connector, Op, Outbound } from './primitives.js';

/** 运行阶段：fake（本地与 CI，不访问网络）、test（第三方沙箱）、prod */
export function stage(): string {
  return process.env.CAGE_STAGE ?? (process.env.NODE_ENV === 'production' ? 'prod' : 'fake');
}

// ---------------- 密钥 ----------------

/** 运行时秘密读取接口；实现可接环境变量或密钥服务，调用者不得把返回值写入日志。 */
export interface SecretProvider {
  get(name: string): Promise<string>;
}

let secretProvider: SecretProvider = {
  async get(name) {
    const v = process.env[name];
    if (!v) throw new Error(`[CAGE-SECRET-001] 缺少密钥 ${name}（由密钥管理服务或环境变量注入）`);
    return v;
  },
};

/** 替换进程级秘密提供器；动态多租户模型应使用单次 credential 回调，避免改变全局配置串用凭据。 */
export function setSecretProvider(p: SecretProvider): void {
  secretProvider = p;
}
export const secrets = { get: (name: string) => secretProvider.get(name) };

// ---------------- 限流 ----------------

const buckets = new Map<string, { tokens: number; at: number }>();
/**
 * 按连接器名维护单进程令牌桶，等待时间算入上层超时并支持取消。
 * perSecond 可小于 1，但桶至少容纳一次请求；此预算不协调多个 API/worker 进程。
 */
export async function take(c: Connector<any>, signal?: AbortSignal): Promise<void> {
  const rate = c.rateLimit?.perSecond;
  if (!rate) return;
  const capacity = Math.max(1, rate); // 低于每秒一次时仍需容纳一个完整令牌。
  for (;;) {
    signal?.throwIfAborted();
    const now = Date.now();
    const b = buckets.get(c.name) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      buckets.set(c.name, b);
      return;
    }
    buckets.set(c.name, b);
    await delay(Math.ceil(((1 - b.tokens) / rate) * 1000), undefined, { signal });
  }
}

// ---------------- fake ----------------

type FakeHandler = (req: any, context: { key: string; signal: AbortSignal }) => unknown | Promise<unknown>;
const fakes = new Map<string, FakeHandler>();
/** fake 阶段的内存调用轨迹，供测试断言；不是生产录制平台，测试需要自行管理累计记录。 */
export const fakeCalls: { connector: string; operation: string; request: unknown; key: string }[] = [];

/** 注册 fake 实现：fakeConnector(erp, { pushOrder: (req) => ({ erpNo: 'FAKE-' + req.externalId }) }) */
export function fakeConnector(c: Connector<any>, handlers: Record<string, FakeHandler>): void {
  for (const [op, h] of Object.entries(handlers)) fakes.set(`${c.name}.${op}`, h);
}

/** 没有注册 fake 时按响应 schema 造一个示例值 */
export function sampleFromSchema(schema: z.ZodType, seed = 'fake'): unknown {
  const js: any = z.toJSONSchema(schema, { unrepresentable: 'any' });
  const gen = (s: any): unknown => {
    if (!s) return null;
    if (s.const !== undefined) return s.const;
    if (s.enum) return s.enum[0];
    if (s.anyOf) return gen(s.anyOf[0]);
    switch (s.type) {
      case 'object':
        return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, gen(v)]));
      case 'array':
        return [];
      case 'string':
        return s.format === 'uuid' ? '00000000-0000-4000-8000-000000000000' : `${seed.toUpperCase()}-${Date.now().toString(36)}`;
      case 'integer':
      case 'number':
        return 0;
      case 'boolean':
        return false;
      default:
        return null;
    }
  };
  return gen(js);
}

// ---------------- 调用 ----------------

/**
 * retryable 表示协议允许自动再试；outcome 区分已知拒绝和远端结果未知，二者不可互相推断。
 * status=null 表示未取得 HTTP 状态，providerCode 仅携带已筛选稳定错误码，不存原始响应正文。
 */
export class ConnectorError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean, readonly outcome: 'rejected' | 'unknown' = 'rejected', readonly providerCode?: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** 同步记录供运维查看，失败仅告警；可靠成功回执另存 connector_execution，不能依赖本日志恢复去重。 */
async function recordCall(k: Kernel | undefined, o: Op, key: string, tenantId: string | null, status: 'ok' | 'failed', httpStatus: number | null, request: unknown, response: unknown, error?: string) {
  if (!k) return;
  await k.app
    .insertInto('sys.sync_record')
    .values({
      tenant_id: tenantId, connector: o.connector.name, operation: o.name, idempotency_key: key, ref_id: key, status,
      http_status: httpStatus, request: JSON.stringify(request), response: response === undefined ? null : JSON.stringify(response), error: error ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'connector', 'operation', 'idempotency_key']).doUpdateSet({
        status, http_status: httpStatus, attempts: sql`sys.sync_record.attempts + 1`, response: response === undefined ? null : JSON.stringify(response),
        error: error ?? null, updated_at: sql`now()`,
      }),
    )
    .execute()
    .catch((e) => k.log.warn({ err: String(e) }, '同步记录写入失败'));
}

/** 将取消与实际 Promise 竞争，确保 fake 也遵守调用超时；底层工作仍应主动监听 signal 释放资源。 */
async function abortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([run(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** 调用一个连接器操作。白名单外的字段直接报错，不会被悄悄发出去。 */
/**
 * 先严格校验请求白名单，再按阶段走 fake 或真实主机；真实请求携带同一个幂等键和按需密钥。
 * 总超时包含令牌等待、请求和响应读取；响应必须符合 schema 才交付，失败归一为 ConnectorError。
 * 本函数只做一次调用，不自行重试；外部副作用能否重试由 effect 与 outbox 消费策略共同决定。
 */
export async function call(o: Op, payload: unknown, key: string, opts: { kernel?: Kernel; tenantId?: string; signal?: AbortSignal } = {}): Promise<any> {
  const body = (o.request as z.ZodObject<any>).strict().parse(payload);
  const timeout = AbortSignal.timeout(o.connector.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let httpStatus: number | null = null;
  try {
    const parsed = await abortable(signal, async () => {
      const st = stage();
      if (st === 'fake') {
        const h = fakes.get(`${o.connector.name}.${o.name}`);
        fakeCalls.push({ connector: o.connector.name, operation: o.name, request: body, key });
        const response = h ? await h(body, { key, signal }) : sampleFromSchema(o.response, o.connector.name);
        httpStatus = 200;
        return o.response.parse(response);
      }
      const host = o.connector.hosts[st];
      if (!host) throw new ConnectorError(`[CAGE-CONN-007] 连接器 ${o.connector.name} 没有 ${st} 环境的地址`, null, false);
      const token = o.connector.secret ? await secrets.get(o.connector.secret) : undefined;
      await take(o.connector, signal);
      const url = new URL(o.path, `https://${host}`);
      if (o.method === 'GET') for (const [field, value] of Object.entries(body)) url.searchParams.set(field, String(value));
      // 超时覆盖限流等待、请求和响应体读取，关闭 worker 同样能取消在途网络 IO。
      const res = await fetch(url, {
        method: o.method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key },
        body: o.method === 'GET' ? undefined : JSON.stringify(body), signal,
      });
      httpStatus = res.status;
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 无效响应由下方 schema 统一诊断，不记录原文。 */ }
      if (!res.ok) throw new ConnectorError(`[CAGE-CONN-009] ${o.connector.name}.${o.name} 返回 ${res.status}`, res.status,
        o.effect !== 'write' && (res.status >= 500 || res.status === 429), res.status >= 500 ? 'unknown' : 'rejected');
      const result = o.response.safeParse(json);
      if (!result.success) throw new ConnectorError(`[CAGE-CONN-010] ${o.connector.name}.${o.name} 的响应格式与声明不符`, res.status, false, 'unknown');
      return result.data;
    });
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'ok', httpStatus, body, parsed);
    return parsed;
  } catch (e) {
    const err = e instanceof ConnectorError ? e : new ConnectorError(`[CAGE-CONN-008] 调用 ${o.connector.name}.${o.name} 失败：${(e as Error)?.name ?? 'Error'}`, httpStatus, o.effect !== 'write', 'unknown');
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'failed', httpStatus, body, undefined, err.message);
    throw err;
  }
}

/** 对对象键排序、保留数组次序以生成请求摘要，拒绝同一业务幂等键被不同请求内容复用。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => (value as any)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`;
}

type OutboundPrepared = { skipped: true } | { skipped: false; response: unknown };

/** 先持久化意图，释放连接后才外呼；成功回执先提交，后续本地回写失败不再外呼。 */
/**
 * 短事务内声明执行意图并领取租约：摘要不符拒绝，已有成功直接复用回执，unknown 隔离禁止重发。
 * 不可重试写的过期 calling 租约也转 unknown，因为进程中断不能证明远端未执行。
 * 释放数据库连接后外呼，成功用租约 token 条件保存回执；后续本地回写失败可重放回执而无需重复外呼。
 * 远端成功但回执未落库的窗口仍依赖远端幂等协议，不能宣称任意外部系统恰好一次。
 */
async function prepareOutbound(k: Kernel, ob: Outbound, row: OutboxRow, consumer: string, signal?: AbortSignal): Promise<OutboundPrepared> {
  const mapped = ob.map(row.payload as any);
  if (mapped === null || mapped === undefined) return { skipped: true };
  const body = (ob.op.request as z.ZodObject<any>).strict().parse(mapped);
  const key = ob.idempotencyKey(row.payload as any);
  if (!key || typeof key !== 'string') throw new ConnectorError('[CAGE-CONN-013] 出站幂等键必须为非空字符串', null, false);
  const requestHash = createHash('sha256').update(canonical(body)).digest('hex');
  const identity = { tenant_id: row.tenant_id, connector: ob.op.connector.name, operation: ob.op.name, idempotency_key: key };
  const locate = (db: typeof k.app) => db.selectFrom('sys.connector_execution').selectAll()
    .where('tenant_id', '=', identity.tenant_id).where('connector', '=', identity.connector)
    .where('operation', '=', identity.operation).where('idempotency_key', '=', identity.idempotency_key);
  const token = randomUUID();
  const claim = await k.app.transaction().execute(async (tx) => {
    await tx.insertInto('sys.connector_execution').values({ ...identity, request_hash: requestHash, status: 'planned', outbox_id: row.id, consumer })
      .onConflict((oc) => oc.columns(['tenant_id', 'connector', 'operation', 'idempotency_key']).doNothing()).execute();
    const previous = await locate(tx).forUpdate().executeTakeFirstOrThrow();
    if (previous.request_hash !== requestHash) return { kind: 'conflict' as const };
    if (previous.status === 'succeeded') return { kind: 'receipt' as const, response: previous.response };
    if (previous.status === 'unknown') return { kind: 'unknown' as const };
    if (previous.status === 'calling' && previous.lease_until && new Date(previous.lease_until).getTime() > Date.now()) return { kind: 'busy' as const };
    if (previous.status === 'calling' && ob.op.effect === 'write') {
      await tx.updateTable('sys.connector_execution').set({ status: 'unknown', error: '执行租约中断，远端结果需人工核对', updated_at: sql`now()` })
        .where('tenant_id', '=', identity.tenant_id).where('connector', '=', identity.connector).where('operation', '=', identity.operation).where('idempotency_key', '=', key).execute();
      return { kind: 'unknown' as const };
    }
    await tx.updateTable('sys.connector_execution')
      .set({ status: 'calling', lease_token: token, lease_until: new Date(Date.now() + ob.op.connector.timeoutMs + 30_000), attempts: sql`attempts + 1`, error: null, updated_at: sql`now()` })
      .where('tenant_id', '=', identity.tenant_id).where('connector', '=', identity.connector).where('operation', '=', identity.operation).where('idempotency_key', '=', key).execute();
    return { kind: 'claimed' as const };
  });
  if (claim.kind === 'conflict') throw new ConnectorError(`[CAGE-CONN-013] ${consumer} 同一幂等键对应不同请求；禁止覆盖已有执行`, null, false);
  if (claim.kind === 'unknown') throw new ConnectorError(`[CAGE-CONN-014] ${consumer} 的不可重试调用结果未知；人工核对远端后再恢复`, null, false, 'unknown');
  if (claim.kind === 'busy') throw new ConnectorError(`${consumer} 的调用仍由其他执行者持有`, null, true);
  if (claim.kind === 'receipt') return { skipped: false, response: ob.op.response.parse(claim.response) };
  let response: unknown;
  try {
    // 回调声明的业务键可能只在租户内唯一；外发键补租户命名空间，重试始终复用。
    response = await call(ob.op, body, `${row.tenant_id}:${key}`, { signal });
  } catch (e) {
    const err = e as ConnectorError;
    const unknown = ob.op.effect === 'write' && err.outcome === 'unknown';
    await k.app.updateTable('sys.connector_execution')
      .set({ status: unknown ? 'unknown' : 'failed', error: String(err.message), lease_token: null, lease_until: null, updated_at: sql`now()` })
      .where('tenant_id', '=', identity.tenant_id).where('connector', '=', identity.connector).where('operation', '=', identity.operation).where('idempotency_key', '=', key).where('lease_token', '=', token).execute();
    await recordCall(k, ob.op, key, row.tenant_id, 'failed', err.status, body, undefined, err.message);
    throw err;
  }
  // 此处崩溃仍只能依靠远端幂等协议。不可重试写的租约超期会进入 unknown，不盲目重发。
  const saved = await k.app.updateTable('sys.connector_execution')
    .set({ status: 'succeeded', response: JSON.stringify(response), error: null, lease_token: null, lease_until: null, updated_at: sql`now()` })
    .where('tenant_id', '=', identity.tenant_id).where('connector', '=', identity.connector).where('operation', '=', identity.operation).where('idempotency_key', '=', key).where('lease_token', '=', token).executeTakeFirst();
  if (Number(saved.numUpdatedRows) !== 1) throw new ConnectorError(`${consumer} 执行租约已失效，未提交本地回写`, null, true, 'unknown');
  await recordCall(k, ob.op, key, row.tenant_id, 'ok', 200, body, response);
  return { skipped: false, response };
}

/** 出站网络执行与短事务回写分离；回写命令与 processed_event 去重登记共同提交。 */
/** prepare 完成网络/回执，handle 仅做短事务命令回写；不可重试异常明确标永久错误进入死信。 */
export function outboundConsumer(k: Kernel, ob: Outbound): EventConsumer {
  const name = `outbound:${ob.op.connector.name}.${ob.op.name}:${ob.event.name}`;
  return {
    name,
    event: ob.event.name,
    async prepare(row, _kernel, { signal }) {
      try {
        return await prepareOutbound(k, ob, row, name, signal);
      } catch (e) {
        if (e instanceof ConnectorError && !e.retryable) {
          // 不可重试：标成永久错误，直接进死信
          throw Object.assign(new Error(`[CAGE-CONN-011] ${e.message}`), { permanent: true });
        }
        throw e;
      }
    },
    async handle(row, tx, _kernel, prepared) {
      if (!prepared) throw new Error('[CAGE-WORKER-002] 出站消费者必须经 worker prepare 阶段执行');
      const result = prepared as OutboundPrepared;
      if (result.skipped) return;
      if (ob.onSuccess) {
        const input = ob.onSuccess.map(result.response, row.payload as any);
        const ctx = systemCtx({ kind: 'external', name: ob.op.connector.name, tenantId: row.tenant_id, capabilities: [k.registry.capabilityOf(ob.onSuccess.command)], requestId: row.request_id ?? undefined });
        await k.executeIn(tx, ob.onSuccess.command, input, ctx, 0);
      }
    },
  };
}
