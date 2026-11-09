// 路由生成：启动时遍历注册表，为命令、聚合、查询、入站回调挂路由；这里只做协议适配，业务授权与状态判断交给内核。
// 业务项目里禁止调用 app.get / app.post（lint 拦截），所以没有声明就没有路由。
import { cageError, isRelation, kebab, systemCtx, type AnyAggregate, type Fields, type Kernel, type RegisteredCommand } from '@yss123/cage-kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerTransfers, transferKey, transferRoutes } from './transfers.js';
import { fileRoutes } from './files.js';

/** HTTP 与 OpenAPI 共用的路由描述；capability 是文档元数据，不能替代执行时授权。 */
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

/** 创建命令尚无对象 ID，其余命令将 ID 放入路径；命名转换与生成契约保持一致。 */
export function commandUrl(c: RegisteredCommand): string {
  const base = `/api/${kebab(c.cmd.agg.name)}`;
  return c.cmd.from === 'new' ? `${base}/${kebab(c.name)}` : `${base}/:id/${kebab(c.name)}`;
}

/**
 * 注册表转换为路由清单，供 HTTP 文档及生成工具使用；本函数本身不注册 Fastify handler。
 * 仅 user 命令有浏览器入口，流程/任务/外部命令必须通过各自受控调用链执行。
 * 关联读取列出源、目标双方能力；查询列出 reads 依赖，使消费者看到完整读权限边界。
 */
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

/**
 * 将请求上下文与输入交给内核，并返回相同注册表派生的文档清单。
 * 对象命令使用路径 ID 覆盖请求体 ID，防止 URL 与实际写目标不一致；用户命令幂等键最多取 200 字符。
 * 入站回调先使用原始请求体验签，再验证载荷并映射命令；external 身份仅持有该目标命令能力。
 * 文件路由在 server 中另行注册，通用导入导出在这里注册；二者仍出现在返回的完整清单中。
 */
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

/** 聚合读取统一经过安全读侧；导出只创建异步任务并返回 202，不在 HTTP 请求里遍历全部数据。 */
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

/**
 * 为对象型查询输入适配 URL 字符串，只转换顶层数字与布尔字段；最终合法性仍由读侧 schema 校验。
 * 布尔值采用当前协议的精确字符串规则：只有 true 字符串转换为真；其余字符串转换为假。
 * 不修改原始 query，也不在这里递归展开数组或嵌套对象。
 */
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

/** 去除可选、可空和默认值包装，只为识别基础标量类型；不执行默认值或实际校验。 */
function unwrap(s: z.ZodType): z.ZodType {
  let cur: any = s;
  while (cur && (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable || cur instanceof z.ZodDefault)) cur = cur.unwrap();
  return cur;
}
