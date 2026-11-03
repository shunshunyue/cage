// 通用任务接口始终挂载（不依赖 /admin 是否开启），因此业务前端也能使用生成的 SDK。
import { cageError, importRequestSchema, kebab, type Kernel } from '@yss123/cage-kernel';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteInfo } from './routes.js';

export const transferRoutes: RouteInfo[] = [
  { method: 'GET', url: '/api/sys/transfers', kind: 'transfer-list' },
  { method: 'GET', url: '/api/sys/transfers/options', kind: 'transfer-options' },
  { method: 'POST', url: '/api/sys/transfers/import', kind: 'import', input: importRequestSchema },
  { method: 'GET', url: '/api/sys/transfers/:id', kind: 'transfer-get' },
  { method: 'GET', url: '/api/sys/transfers/:id/download', kind: 'transfer-download' },
];

/** 不截断幂等键，避免两个不同请求因前缀相同而被当作同一次提交。 */
export function transferKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !key || key.length > 200) throw cageError('INVALID_INPUT', '任务提交需要 Idempotency-Key（1–200 字符）');
  return key;
}

export function registerTransfers(app: FastifyInstance, k: Kernel) {
  app.get('/api/sys/transfers', (req) => k.transfers.list(req.cageCtx, (req.query as { aggregate?: string }).aggregate));
  app.get('/api/sys/transfers/options', async (req) => {
    if (!req.cageCtx.userId) throw cageError('UNAUTHENTICATED');
    const can = (cap: string) => req.cageCtx.capabilities.has(cap);
    return {
      exports: k.registry.aggregates.filter((a) => can(`${a.name}.export`)).map((a) => ({
        name: a.name, title: a.description ?? a.name, url: `/api/${kebab(a.name)}/export`,
      })),
      imports: k.registry.commands.filter((c) => c.cmd.invokedBy.includes('user') && c.cmd.input instanceof z.ZodObject && can(c.capability)).map((c) => ({
        command: c.capability, title: c.cmd.description ?? c.capability,
        // 这是输入表头，不能使用读侧导出表头：读侧包含系统列、掩码值，不能直接回写。
        fields: Object.entries((c.cmd.input as z.ZodObject).shape).map(([name, schema]) => ({ name, required: !(schema as z.ZodType).isOptional() })),
      })),
      limits: { importBytes: 1_048_576, importRows: 1000, exportRows: 100000, exportBytes: 20 * 1024 * 1024, retentionHours: 24 },
    };
  });
  // 文件由浏览器读取为 UTF-8 CSV，通过 JSON 上传；6 MiB 覆盖 JSON 转义膨胀，
  // 服务仍按解码后 1 MiB 限制原文件。其他接口继续保持原来的 1 MiB 上限。
  app.post('/api/sys/transfers/import', { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const task = await k.transfers.import(req.body, req.cageCtx, transferKey(req));
    return reply.code(202).send(task);
  });
  app.get('/api/sys/transfers/:id', (req) => k.transfers.get((req.params as { id: string }).id, req.cageCtx));
  app.get('/api/sys/transfers/:id/download', async (req, reply) => {
    const file = await k.transfers.download((req.params as { id: string }).id, req.cageCtx);
    return reply.header('cache-control', 'no-store').header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.filename}"`).send(file.body);
  });
}
