// 启动时根据注册表输出一份 OpenAPI 文档；前端 SDK 由 cage gen 从声明里的 Zod schema 生成。
import { hiddenFields, type Kernel } from '@yss123/cage-kernel';
import { z } from 'zod';
import type { RouteInfo } from './routes.js';

const ERR = { $ref: '#/components/schemas/CageError' };

function schemaOf(s: z.ZodType): unknown {
  try {
    return z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' });
  } catch {
    return {};
  }
}

export function buildOpenApi(k: Kernel, routes: RouteInfo[], info: { title?: string; version?: string } = {}) {
  const schemas: Record<string, unknown> = {
    CageError: {
      type: 'object',
      properties: { code: { type: 'string' }, domainCode: { type: 'string' }, detail: {} },
      required: ['code'],
    },
  };
  for (const a of k.registry.aggregates) {
    const props: Record<string, unknown> = { id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: [...a.states.values] }, version: { type: 'integer' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' } };
    const hidden = new Set(hiddenFields(a));
    const js: any = schemaOf(a.schema);
    for (const [f, p] of Object.entries(js.properties ?? {})) if (!hidden.has(f)) props[f] = (a.fields as any)[f]?.sensitiveKind ? { type: ['string', 'null'], description: '敏感字段：按权限返回掩码值' } : p;
    schemas[a.name] = { type: 'object', properties: props };
  }
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const url = r.url.replace(/:([a-zA-Z]+)/g, '{$1}');
    const op: Record<string, unknown> = {
      operationId: `${r.kind}_${url.replace(/[^a-zA-Z0-9]+/g, '_')}`,
      summary: r.command?.cmd.description ?? r.capability,
      'x-capability': r.capability,
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: r.aggregate && r.kind !== 'list' && r.kind !== 'export' ? { $ref: `#/components/schemas/${r.aggregate}` } : {} } } }, default: { description: '错误', content: { 'application/json': { schema: ERR } } } },
    };
    if (url.includes('{id}')) op.parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }];
    if (r.method === 'POST' && r.input) op.requestBody = { content: { 'application/json': { schema: schemaOf(r.input) } } };
    if (r.kind === 'command') op.parameters = [...((op.parameters as unknown[]) ?? []), { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }];
    (paths[url] ??= {})[r.method.toLowerCase()] = op;
  }
  return { openapi: '3.1.0', info: { title: info.title ?? 'cage api', version: info.version ?? '0.0.0' }, paths, components: { schemas } };
}
