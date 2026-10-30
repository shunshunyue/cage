// 连接器运行时：每一道管控都在这里发生——字段白名单、地址白名单、密钥、限流、超时、调用记录、响应校验。
import { systemCtx, type Kernel } from '@yss123/cage-kernel';
import type { EventConsumer } from '@yss123/cage-kernel/worker';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Connector, Op, Outbound } from './primitives.js';

/** 运行阶段：fake（本地与 CI，不访问网络）、test（第三方沙箱）、prod */
export function stage(): string {
  return process.env.CAGE_STAGE ?? (process.env.NODE_ENV === 'production' ? 'prod' : 'fake');
}

// ---------------- 密钥 ----------------

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

export function setSecretProvider(p: SecretProvider): void {
  secretProvider = p;
}
export const secrets = { get: (name: string) => secretProvider.get(name) };

// ---------------- 限流 ----------------

const buckets = new Map<string, { tokens: number; at: number }>();
export async function take(c: Connector<any>): Promise<void> {
  const rate = c.rateLimit?.perSecond;
  if (!rate) return;
  for (;;) {
    const now = Date.now();
    const b = buckets.get(c.name) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      buckets.set(c.name, b);
      return;
    }
    buckets.set(c.name, b);
    await new Promise((r) => setTimeout(r, Math.ceil(((1 - b.tokens) / rate) * 1000)));
  }
}

// ---------------- fake ----------------

type FakeHandler = (req: any) => unknown | Promise<unknown>;
const fakes = new Map<string, FakeHandler>();
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

export class ConnectorError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = 'ConnectorError';
  }
}

async function recordCall(k: Kernel | undefined, o: Op, key: string, tenantId: string | null, status: 'ok' | 'failed', httpStatus: number | null, request: unknown, response: unknown, error?: string) {
  if (!k) return;
  await k.app
    .insertInto('sys.sync_record')
    .values({
      tenant_id: tenantId, connector: o.connector.name, operation: o.name, idempotency_key: key, ref_id: key, status,
      http_status: httpStatus, request: JSON.stringify(request), response: response === undefined ? null : JSON.stringify(response), error: error ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['connector', 'operation', 'idempotency_key']).doUpdateSet({
        status, http_status: httpStatus, attempts: sql`sys.sync_record.attempts + 1`, response: response === undefined ? null : JSON.stringify(response),
        error: error ?? null, updated_at: sql`now()`,
      }),
    )
    .execute()
    .catch((e) => k.log.warn({ err: String(e) }, '同步记录写入失败'));
}

/** 调用一个连接器操作。白名单外的字段直接报错，不会被悄悄发出去。 */
export async function call(o: Op, payload: unknown, key: string, opts: { kernel?: Kernel; tenantId?: string } = {}): Promise<any> {
  const body = (o.request as z.ZodObject<any>).strict().parse(payload);
  const st = stage();
  if (st === 'fake') {
    const h = fakes.get(`${o.connector.name}.${o.name}`);
    const res = h ? await h(body) : sampleFromSchema(o.response, o.connector.name);
    fakeCalls.push({ connector: o.connector.name, operation: o.name, request: body, key });
    const parsed = o.response.parse(res);
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'ok', 200, body, parsed);
    return parsed;
  }
  const host = o.connector.hosts[st];
  if (!host) throw new ConnectorError(`[CAGE-CONN-007] 连接器 ${o.connector.name} 没有 ${st} 环境的地址`, null, false);
  const token = o.connector.secret ? await secrets.get(o.connector.secret) : undefined;
  await take(o.connector);
  const url = new URL(o.path, `https://${host}`);
  if (o.method === 'GET') for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    // 生产环境出站流量经过出口代理：设置 HTTPS_PROXY 与 NODE_USE_ENV_PROXY=1
    res = await fetch(url, {
      method: o.method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'idempotency-key': key,
      },
      body: o.method === 'GET' ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(o.connector.timeoutMs),
    });
  } catch (e) {
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'failed', null, body, undefined, String(e));
    throw new ConnectorError(`[CAGE-CONN-008] 调用 ${o.connector.name}.${o.name} 失败：${String(e)}`, null, true);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'failed', res.status, body, json);
    const retryable = o.effect === 'retryableWrite' || o.effect === 'read' ? res.status >= 500 || res.status === 429 : false;
    throw new ConnectorError(`[CAGE-CONN-009] ${o.connector.name}.${o.name} 返回 ${res.status}`, res.status, retryable);
  }
  const parsed = o.response.safeParse(json);
  if (!parsed.success) {
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'failed', res.status, body, json, '响应格式不符合声明');
    throw new ConnectorError(`[CAGE-CONN-010] ${o.connector.name}.${o.name} 的响应格式与声明不符`, res.status, false);
  }
  await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'ok', res.status, body, parsed.data);
  return parsed.data;
}

/** 出站映射的事件消费者：调用第三方，成功后以 external 身份执行回写命令，和去重登记同一个事务 */
export function outboundConsumer(k: Kernel, ob: Outbound): EventConsumer {
  const name = `outbound:${ob.op.connector.name}.${ob.op.name}:${ob.event.name}`;
  return {
    name,
    event: ob.event.name,
    async handle(row, tx) {
      const req = ob.map(row.payload as any);
      if (req === null || req === undefined) return;
      const key = ob.idempotencyKey(row.payload as any);
      let res: any;
      try {
        res = await call(ob.op, req, key, { kernel: k, tenantId: row.tenant_id });
      } catch (e) {
        if (e instanceof ConnectorError && !e.retryable) {
          // 不可重试：标成永久错误，直接进死信
          throw Object.assign(new Error(`[CAGE-CONN-011] ${e.message}`), { permanent: true });
        }
        throw e;
      }
      if (ob.onSuccess) {
        const input = ob.onSuccess.map(res, row.payload as any);
        const ctx = systemCtx({ kind: 'external', name: ob.op.connector.name, tenantId: row.tenant_id, capabilities: [k.registry.capabilityOf(ob.onSuccess.command)], requestId: row.request_id ?? undefined });
        await k.executeIn(tx, ob.onSuccess.command, input, ctx, 0);
      }
    },
  };
}
