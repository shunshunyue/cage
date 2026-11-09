// 分片路由使用原始字节流，复用会话/CSRF；不经过全局 JSON 解析器和 1 MiB 请求体限制。
import { Readable } from 'node:stream';
import { cageError } from '@yss123/cage-kernel';
import { beginUploadSchema, type FileService } from '@yss123/cage-files';
import type { FastifyInstance } from 'fastify';
import type { RouteInfo } from './routes.js';
import { transferKey } from './transfers.js';

/** 上传会话与私有下载的协议清单；具体授权依赖会话和目标对象，无法用单个固定 capability 表达。 */
export const fileRoutes: RouteInfo[] = [
  { method: 'POST', url: '/api/sys/uploads', kind: 'upload-begin', input: beginUploadSchema },
  { method: 'GET', url: '/api/sys/uploads', kind: 'upload-list' },
  { method: 'GET', url: '/api/sys/uploads/:id', kind: 'upload-get' },
  { method: 'POST', url: '/api/sys/uploads/:id/parts/:number', kind: 'upload-part' },
  { method: 'POST', url: '/api/sys/uploads/:id/complete', kind: 'upload-complete' },
  { method: 'POST', url: '/api/sys/uploads/:id/cancel', kind: 'upload-cancel' },
  { method: 'GET', url: '/api/sys/files/:id', kind: 'file-info' },
  { method: 'GET', url: '/api/sys/files/:id/download', kind: 'file-download' },
];

/**
 * 将 HTTP 字节流交给 FileService，统一复用当前请求的登录上下文和全局 CSRF 保护。
 * 分片要求 Content-Length 与 SHA-256，长度上限使用服务配置；准确字节数和摘要由存储层校验。
 * 下载仅支持一个闭区间 bytes 范围，非法范围返回 416；有效范围返回 206 和准确 Content-Length。
 * 元数据读取及实际下载分别复核访问条件，FileService 在交付前记录审计；响应禁止共享缓存并强制附件下载。
 */
export async function registerFiles(app: FastifyInstance, files: FileService) {
  app.post('/api/sys/uploads', req => files.begin(req.body, req.cageCtx, transferKey(req)));
  app.get('/api/sys/uploads', req => {
    const query = req.query as { command?: string; field?: string; targetId?: string };
    if (!query.command || !query.field) throw cageError('INVALID_INPUT', '需要 command 和 field');
    return files.list(query.command, query.field, query.targetId ?? null, req.cageCtx);
  });
  app.get('/api/sys/uploads/:id', req => files.get((req.params as { id: string }).id, req.cageCtx));
  app.post('/api/sys/uploads/:id/complete', req => files.complete((req.params as { id: string }).id, req.cageCtx));
  app.post('/api/sys/uploads/:id/cancel', req => files.cancel((req.params as { id: string }).id, req.cageCtx));
  // 解析器只在这个封装作用域生效；流式存储自己校验准确分片长度和校验和。
  await app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    scope.post('/api/sys/uploads/:id/parts/:number', {
      bodyLimit: files.partBytes,
      onRequest: async req => {
        const length = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 1 || length > files.partBytes) throw cageError('INVALID_INPUT', '分片需要合法的 Content-Length');
      },
    }, req => {
      const { id, number } = req.params as { id: string; number: string };
      const hash = req.headers['x-content-sha256'];
      if (!(req.body instanceof Readable) || typeof hash !== 'string' || !/^[1-9]\d*$/.test(number)) throw cageError('INVALID_INPUT');
      return files.putPart(id, Number(number), hash, req.body, req.cageCtx);
    });
  });
  app.get('/api/sys/files/:id', req => files.info((req.params as { id: string }).id, req.cageCtx));
  app.get('/api/sys/files/:id/download', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const info = await files.info(id, req.cageCtx);
    const header = req.headers.range;
    let range: { start: number; end: number } | undefined;
    if (header) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(header);
      const invalid = () => reply.code(416).header('content-range', `bytes */${info.bytes}`).send();
      if (!match || (!match[1] && !match[2])) return invalid();
      const start = match[1] ? Number(match[1]) : Math.max(0, info.bytes - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), info.bytes - 1) : info.bytes - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= info.bytes || end < start || (!match[1] && Number(match[2]) === 0)) return invalid();
      range = { start, end };
    }
    const result = await files.download(id, req.cageCtx, range);
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-type', info.contentType).header('accept-ranges', 'bytes')
      .header('content-disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(info.filename).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)}`)
      .header('content-length', range ? range.end - range.start + 1 : info.bytes);
    if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${info.bytes}`);
    return reply.send(result.stream);
  });
}
