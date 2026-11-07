// 启动时根据注册表输出一份 OpenAPI 文档；前端 SDK 由 cage gen 从声明里的 Zod schema 生成。
import { hiddenFields, isRelation, runtimeServices, type Fields, type Kernel } from '@yss123/cage-kernel';
import { z } from 'zod';
import type { RouteInfo } from './routes.js';

const ERR = { $ref: '#/components/schemas/CageError' };

function schemaOf(s: z.ZodType): unknown {
  return z.toJSONSchema(s, {
    unrepresentable: 'any', io: 'input',
    override: ({ zodSchema, jsonSchema }) => {
      const def = (zodSchema as any)._zod?.def;
      const custom = def?.checks?.some((check: any) => ['custom', 'overwrite'].includes(check._zod?.def?.check));
      const flaggedPattern = def?.checks?.some((check: any) => check._zod?.def?.pattern instanceof RegExp && check._zod.def.pattern.flags);
      if (def?.type === 'catch' || def?.checks?.some((check: any) => check._zod?.def?.check === 'overwrite'))
        for (const key of Object.keys(jsonSchema)) delete (jsonSchema as any)[key];
      else if (flaggedPattern) { delete jsonSchema.pattern; delete jsonSchema.allOf; }
      if (custom || flaggedPattern || def?.coerce || ['transform', 'pipe', 'date', 'bigint', 'custom', 'catch', 'prefault', 'lazy', 'undefined', 'void', 'file', 'readonly', 'map', 'set', 'symbol', 'promise', 'function'].includes(def?.type))
        Object.assign(jsonSchema, { 'x-cage-server-validation': true, 'x-cage-validation-note': '自定义或不可表达的校验仅在服务端执行；本 schema 不代表完整验证。' });
    },
  });
}

export function buildOpenApi(k: Kernel, routes: RouteInfo[], info: { title?: string; version?: string } = {}) {
  const schemas: Record<string, unknown> = {
    CageError: {
      type: 'object',
      properties: { code: { type: 'string' }, domainCode: { type: 'string' }, detail: {} },
      required: ['code'],
    },
    TransferTask: {
      type: 'object', required: ['id', 'kind', 'target', 'status', 'createdAt', 'expiresAt'],
      properties: {
        id: { type: 'string', format: 'uuid' }, kind: { type: 'string', enum: ['export', 'import'] }, target: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'processing', 'retrying', 'completed', 'failed', 'expired'] },
        createdAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
        finishedAt: { type: ['string', 'null'] }, errorCode: { type: ['string', 'null'] }, result: { type: ['object', 'null'] },
      },
    },
  };
  for (const a of k.registry.aggregates) {
    const props: Record<string, unknown> = { id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: [...a.states.values] }, version: { type: 'integer' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' } };
    const hidden = new Set(hiddenFields(a));
    const js: any = schemaOf(a.schema);
    for (const [f, p] of Object.entries(js.properties ?? {})) if (!hidden.has(f) && !isRelation((a.fields as Fields)[f])) props[f] = (a.fields as Fields)[f]?.sensitiveKind ? { type: ['string', 'null'], description: '敏感字段：按权限返回掩码值' } : p;
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
    if (r.kind === 'list' || r.kind === 'related') {
      const target = k.registry.aggregate(r.targetAggregate ?? r.aggregate!)!;
      (op.responses as any)[200].content['application/json'].schema = {
        type: 'object', required: ['items', 'total', 'page', 'pageSize'], properties: {
          items: { type: 'array', items: { $ref: `#/components/schemas/${target.name}` } },
          total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' },
        },
      };
      const parameters = [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        { name: 'sort', in: 'query', schema: { type: 'string' }, description: '目标对象字段；前缀 - 表示降序' },
        ...Object.entries(target.fields as Fields).filter(([, f]) => !f.isHidden && !isRelation(f) && f.sql !== 'jsonb' && !f.sensitiveKind)
          .map(([name, f]) => ({ name, in: 'query', schema: schemaOf(f.base) })),
      ];
      op.parameters = [...((op.parameters as unknown[]) ?? []), ...parameters];
      if (r.kind === 'related') op.description = '分页读取关联对象，同时检查所属对象和目标对象的 read 能力与数据范围；目标敏感字段按权限掩码。';
    }
    if (r.method === 'POST' && r.input) op.requestBody = { content: { 'application/json': { schema: schemaOf(r.input) } } };
    const taskSchema = { $ref: '#/components/schemas/TransferTask' };
    if (r.kind === 'export' || r.kind === 'import') {
      op.responses = { 202: { description: '已入队，使用任务接口查询进度并下载文件', content: { 'application/json': { schema: taskSchema } } }, default: { description: '错误', content: { 'application/json': { schema: ERR } } } };
      if (r.kind === 'export') op.requestBody = { content: { 'application/json': { schema: { type: 'object', description: '与列表相同的筛选参数；忽略 page/pageSize，导出所有匹配行' } } } };
    }
    if (r.kind === 'transfer-get' || r.kind === 'transfer-list') {
      (op.responses as any)[200].content['application/json'].schema = r.kind === 'transfer-list' ? { type: 'array', items: taskSchema } : taskSchema;
    }
    if (r.kind === 'transfer-list') op.parameters = [{ name: 'aggregate', in: 'query', required: false, schema: { type: 'string' }, description: '只查询当前业务对象的导入和导出任务' }];
    if (r.kind === 'transfer-download') (op.responses as any)[200] = { description: '本人已完成且未过期的文件；重新检查权限', content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object' } } } };
    if (['command', 'export', 'import'].includes(r.kind)) op.parameters = [...((op.parameters as unknown[]) ?? []), { name: 'Idempotency-Key', in: 'header', required: r.kind !== 'command', schema: { type: 'string', minLength: 1, maxLength: 200 } }];
    if (r.kind.startsWith('upload-')) {
      const sessionSchema = {
        type: 'object', required: ['id', 'status', 'partBytes', 'partCount', 'parts', 'bytes', 'expiresAt'],
        properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['uploading', 'completing', 'ready', 'bound', 'deleting', 'deleted'] },
          partBytes: { type: 'integer' }, partCount: { type: 'integer' }, bytes: { type: 'integer' }, filename: { type: 'string' }, contentType: { type: 'string' },
          aggregate: { type: 'string' }, field: { type: 'string' }, command: { type: 'string' }, targetId: { type: ['string', 'null'], format: 'uuid' }, expiresAt: { type: 'string', format: 'date-time' },
          parts: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, bytes: { type: 'integer' }, sha256: { type: 'string' } } } } },
      };
      if (['upload-begin', 'upload-get', 'upload-complete', 'upload-list'].includes(r.kind))
        (op.responses as any)[200].content['application/json'].schema = r.kind === 'upload-list' ? { type: 'array', items: sessionSchema } : sessionSchema;
      op.description = '需要登录及目标用户命令能力；修改已有对象时检查 read/范围和命令起始状态。会话只对上传者开放。';
      if (r.kind === 'upload-begin') op.parameters = [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 200 } }];
      if (r.kind === 'upload-list') op.parameters = [
        { name: 'command', in: 'query', required: true, schema: { type: 'string' } }, { name: 'field', in: 'query', required: true, schema: { type: 'string' } }, { name: 'targetId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ];
      if (r.kind === 'upload-part') {
        op.parameters = [...((op.parameters as unknown[]) ?? []), { name: 'number', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'X-Content-SHA256', in: 'header', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
          { name: 'Content-Length', in: 'header', required: true, schema: { type: 'integer', minimum: 1 } }];
        op.requestBody = { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
      }
    }
    if (r.kind === 'file-info') (op.responses as any)[200].content['application/json'].schema = { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, filename: { type: 'string' }, bytes: { type: 'integer' }, contentType: { type: 'string' } } };
    if (r.kind === 'file-download') {
      op.description = '按所属对象当前 read/范围授权，交付前可靠审计；临时文件仅上传者可下载。';
      op.parameters = [...((op.parameters as unknown[]) ?? []), { name: 'Range', in: 'header', schema: { type: 'string' }, description: '单个 bytes 范围，支持后缀范围' }];
      op.responses = { 200: { description: '完整私有文件', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        206: { description: '单段文件内容' }, 416: { description: '范围非法' }, default: { description: '错误', content: { 'application/json': { schema: ERR } } } };
    }
    (paths[url] ??= {})[r.method.toLowerCase()] = op;
  }
  for (const service of runtimeServices(k)) for (const [path, operations] of Object.entries(service.openapi?.() ?? {})) paths[path] = { ...paths[path], ...operations };
  return { openapi: '3.1.0', info: { title: info.title ?? 'cage api', version: info.version ?? '0.0.0' }, paths, components: { schemas } };
}
