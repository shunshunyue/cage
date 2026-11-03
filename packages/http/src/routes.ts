// 路由生成：启动时遍历注册表，为每个命令、聚合、查询、入站回调挂路由。路由本身不做任何判断，全部交给内核。
// 业务项目里禁止调用 app.get / app.post（lint 拦截），所以没有声明就没有路由。
import { cageError, isRelation, kebab, systemCtx, type AnyAggregate, type Fields, type Kernel, type RegisteredCommand } from '@yss123/cage-kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerTransfers, transferKey, transferRoutes } from './transfers.js';
import { fileRoutes } from './files.js';

export interface RouteInfo {
  method: 'GET' | 'POST';
  url: string;
  kind: 'command' | 'list' | 'get' | 'related' | 'export' | 'query' | 'hook' | 'import' | 'transfer-list' | 'transfer-get' | 'transfer-download' | 'transfer-options'
    | 'upload-begin' | 'upload-list' | 'upload-get' | 'upload-part' | 'upload-complete' | 'upload-cancel' | 'file-info' | 'file-download';
  capability?: string;
  aggregate?: string;
  /** related 的响应类型来自目标聚合，所属对象仍在 aggregate 中。 */
  targetAggregate?: string;
  relation?: string;
  command?: RegisteredCommand;
  input?: z.ZodType;
}

export function commandUrl(c: RegisteredCommand): string {
  const base = `/api/${kebab(c.cmd.agg.name)}`;
  return c.cmd.from === 'new' ? `${base}/${kebab(c.name)}` : `${base}/:id/${kebab(c.name)}`;
}

/** 注册表 → 路由清单（cage gen 也用它生成路由清单和前端 SDK） */
export function routeTable(k: Kernel): RouteInfo[] {
  const out: RouteInfo[] = [...transferRoutes, ...fileRoutes];
  for (const c of k.registry.commands) {
    if (!c.cmd.invokedBy.includes('user')) continue; // 流程、任务、外部专用命令不对浏览器开放
    out.push({ method: 'POST', url: commandUrl(c), kind: 'command', capability: c.capability, aggregate: c.cmd.agg.name, command: c, input: c.cmd.input });
  }
  for (const a of k.registry.aggregates) {
    const base = `/api/${kebab(a.name)}`;
    out.push({ method: 'GET', url: base, kind: 'list', capability: `${a.name}.read`, aggregate: a.name });
    out.push({ method: 'POST', url: `${base}/export`, kind: 'export', capability: `${a.name}.export`, aggregate: a.name });
    out.push({ method: 'GET', url: `${base}/:id`, kind: 'get', capability: `${a.name}.read`, aggregate: a.name });
    for (const [key, field] of Object.entries(a.fields as Fields)) if (isRelation(field))
      out.push({ method: 'GET', url: `${base}/:id/relations/${kebab(key)}`, kind: 'related',
        capability: [...new Set([`${a.name}.read`, `${field.ref}.read`])].join(','), aggregate: a.name, targetAggregate: field.ref, relation: key });
  }
  for (const q of k.registry.queries) {
    out.push({ method: 'GET', url: `/api/queries/${kebab(q.name)}`, kind: 'query', capability: q.reads.map((r) => `${r.name}.read`).join(','), input: q.input });
  }
  for (const e of k.registry.extensions) {
    if (e.kind === 'INBOUND') out.push({ method: 'POST', url: `/hooks/${e.value.connector.name}/${kebab(e.value.event)}`, kind: 'hook' });
  }
  return out;
}

export function registerRoutes(app: FastifyInstance, k: Kernel): RouteInfo[] {
  const table = routeTable(k);
  registerTransfers(app, k);
  for (const c of k.registry.commands) {
    if (!c.cmd.invokedBy.includes('user')) continue;
    app.post(commandUrl(c), async (req) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const params = req.params as { id?: string };
      const input = params.id ? { ...body, id: params.id } : body;
      const key = req.headers['idempotency-key'];
      return k.execute(c.cmd, input, { ...req.cageCtx, idempotencyKey: typeof key === 'string' ? key.slice(0, 200) : undefined });
    });
  }
  for (const a of k.registry.aggregates) registerAggregate(app, k, a);
  for (const q of k.registry.queries) {
    app.get(`/api/queries/${kebab(q.name)}`, async (req) => k.read.run(q, coerceQuery(q.input, req.query as Record<string, unknown>), req.cageCtx));
  }
  for (const e of k.registry.extensions) {
    if (e.kind !== 'INBOUND') continue;
    const inb = e.value;
    app.post(`/hooks/${inb.connector.name}/${kebab(inb.event)}`, async (req) => {
      // 先验签，再映射到命令；以 external 身份调用
      const secret = process.env[inb.verify.secret];
      if (!secret) throw new Error(`[CAGE-SECRET-001] 缺少密钥 ${inb.verify.secret}`);
      if (!inb.verify.verify(req.rawBody ?? '', req.headers as any, secret)) throw cageError('UNAUTHENTICATED');
      const parsed = inb.payload.safeParse(req.body);
      if (!parsed.success) throw cageError('INVALID_INPUT', parsed.error.issues.map((i: any) => ({ path: i.path.join('.'), message: i.message })));
      const ctx = systemCtx({
        kind: 'external', name: inb.connector.name, tenantId: req.cageCtx.tenantId,
        capabilities: [k.registry.capabilityOf(inb.command)], requestId: String(req.id),
      });
      const key = req.headers['idempotency-key'];
      return k.execute(inb.command, inb.map(parsed.data), { ...ctx, idempotencyKey: typeof key === 'string' ? key : undefined });
    });
  }
  return table;
}

function registerAggregate(app: FastifyInstance, k: Kernel, a: AnyAggregate) {
  const base = `/api/${kebab(a.name)}`;
  app.get(base, async (req) => k.read.list(a, req.query as Record<string, unknown>, req.cageCtx));
  app.get(`${base}/:id`, async (req) => k.read.get(a, (req.params as { id: string }).id, req.cageCtx));
  for (const [key, field] of Object.entries(a.fields as Fields)) if (isRelation(field))
    app.get(`${base}/:id/relations/${kebab(key)}`, async (req) =>
      k.read.related(a, (req.params as { id: string }).id, key, req.query as Record<string, unknown>, req.cageCtx));
  app.post(`${base}/export`, async (req, reply) => {
    const parsed = z.record(z.string(), z.unknown()).safeParse(req.body ?? {});
    if (!parsed.success) throw cageError('INVALID_INPUT', '导出筛选参数必须是对象');
    const task = await k.transfers.export(a.name, parsed.data, req.cageCtx, transferKey(req));
    return reply.code(202).send(task);
  });
}

/** 查询字符串都是字符串：按输入 schema 把数字和布尔转换过来 */
function coerceQuery(schema: z.ZodType, q: Record<string, unknown>): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return q;
  const out: Record<string, unknown> = { ...q };
  for (const [k, s] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    const v = q[k];
    if (typeof v !== 'string') continue;
    const inner = unwrap(s);
    if (inner instanceof z.ZodNumber) out[k] = Number(v);
    else if (inner instanceof z.ZodBoolean) out[k] = v === 'true';
  }
  return out;
}

function unwrap(s: z.ZodType): z.ZodType {
  let cur: any = s;
  while (cur && (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable || cur instanceof z.ZodDefault)) cur = cur.unwrap();
  return cur;
}
