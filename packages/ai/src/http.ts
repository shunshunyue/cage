import { setTimeout as delay } from 'node:timers/promises';
import { cageError, isCageError, type Ctx } from '@yss123/cage-kernel';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { needUser, parse } from './security.js';
import { TERMINAL } from './types.js';
import type { AiRuntime } from './runtime.js';
import { messageInputSchema, interactionResponseSchema, modelConfigSchema, personalityInputSchema, personalitySettingsSchema,
  personalitySelectionSchema, personalityPreviewSchema, sessionInputSchema, type AiPersonalityPreviewEvent } from '@yss123/cage-ai-protocol';
import { MODEL_CAPABILITY } from './models.js';
import { PERSONALITY_CAPABILITY } from './personalities.js';

export function aiOpenApi(): Record<string, Record<string, unknown>> {
  const definitions: [string, string, string, number, z.ZodType?][] = [
    ['get', '/api/ai/sessions', '本人会话列表', 200], ['post', '/api/ai/sessions', '新建会话', 201, sessionInputSchema],
    ['get', '/api/ai/personalities', '可用助理性格与默认项', 200],
    ['post', '/api/ai/sessions/{id}/personality', '选择会话性格（下一轮生效）', 200, personalitySelectionSchema],
    ['get', '/api/ai/sessions/{id}/runs', '本人会话轮次', 200], ['post', '/api/ai/sessions/{id}/messages', '提交消息与页面快照', 202, messageInputSchema],
    ['get', '/api/ai/runs/{id}', '运行状态和待处理互动', 200], ['get', '/api/ai/runs/{id}/events', '按序号读取或订阅事件', 200],
    ['post', '/api/ai/runs/{id}/cancel', '取消运行', 200], ['post', '/api/ai/runs/{id}/interactions/{interactionId}', '回复互动', 200, interactionResponseSchema],
    ['get', '/api/ai/memory', '本人偏好', 200], ['delete', '/api/ai/memory/{id}', '删除本人偏好', 200],
    ['get', '/api/ai/admin/models', '本租户模型配置（不返回密钥）', 200],
    ['post', '/api/ai/admin/models/{key}', '保存模型配置', 200, modelConfigSchema],
    ['post', '/api/ai/admin/models/{key}/test', '测试已保存的模型连接', 200],
    ['get', '/api/ai/admin/personalities', '本租户助理性格配置', 200],
    ['post', '/api/ai/admin/personalities/{key}', '保存助理性格', 200, personalityInputSchema],
    ['post', '/api/ai/admin/assistant-settings', '设置默认助理性格', 200, personalitySettingsSchema],
    ['post', '/api/ai/admin/personality-preview', '试聊未保存的性格（支持 SSE）', 200, personalityPreviewSchema],
  ];
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, summary, status, schema] of definitions) {
    const parameters: unknown[] = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string', ...(m[1] === 'key' ? {} : { format: 'uuid' }) } }));
    if (path.endsWith('/messages')) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 160 } });
    if (path.endsWith('/events')) parameters.push({ name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } });
    (paths[path] ??= {})[method] = { summary, 'x-capability': path.includes('/admin/models') ? MODEL_CAPABILITY : path.includes('/admin/') ? PERSONALITY_CAPABILITY : 'Sys.ai.use', parameters,
      ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) } } } } : {}),
      responses: { [status]: { description: summary, content: { 'application/json': { schema: {} }, ...((path.endsWith('/events') || path.endsWith('/personality-preview')) ? { 'text/event-stream': { schema: { type: 'string' } } } : {}) } },
        default: { description: 'CageError；校验登录、CSRF、归属和当前授权', content: { 'application/json': { schema: { $ref: '#/components/schemas/CageError' } } } } } };
  }
  return paths;
}

/** 固定框架接口复用宿主的 cookie/CSRF/限流。运行、互动和事件均按登录租户及用户隔离。 */
export function mountHttp(app: FastifyInstance, runtime: AiRuntime): void {
  const streams = new Set<AbortController>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.abort(); });
  const identity = async (req: any, assistant = true): Promise<Ctx> => {
    const session = req.cageSession;
    if (!session) throw cageError('UNAUTHENTICATED');
    const valid = await runtime.kernel.app.selectFrom('sys.session').select('id').where('id', '=', session.id)
      .where('tenant_id', '=', session.tenantId).where('user_id', '=', session.userId).where('expires_at', '>', new Date()).executeTakeFirst();
    if (!valid) throw cageError('UNAUTHENTICATED');
    const ctx = await runtime.kernel.contextFor(session.userId, session.tenantId, { stepUpAt: session.stepUpAt, source: 'api', requestId: String(req.id) });
    if (!ctx) throw cageError('UNAUTHENTICATED');
    if (assistant) needUser(ctx); return ctx;
  };
  app.get('/api/ai/admin/models', async req => runtime.models.list(await identity(req, false)));
  app.post('/api/ai/admin/models/:key', async req => runtime.models.save(await identity(req, false), (req.params as any).key, req.body));
  app.post('/api/ai/admin/models/:key/test', async req => runtime.models.test(await identity(req, false), (req.params as any).key));
  app.get('/api/ai/admin/personalities', async req => runtime.personalities.list(await identity(req, false)));
  app.post('/api/ai/admin/personalities/:key', async req => runtime.personalities.save(await identity(req, false), (req.params as any).key, req.body));
  app.post('/api/ai/admin/assistant-settings', async req => runtime.personalities.saveSettings(await identity(req, false), req.body));
  app.get('/api/ai/personalities', async req => runtime.personalities.available(await identity(req)));
  app.post('/api/ai/sessions/:id/personality', async req => runtime.selectPersonality(await identity(req), (req.params as any).id, req.body));
  app.post('/api/ai/admin/personality-preview', async (req, reply) => {
    const ctx = await identity(req, false); runtime.personalities.need(ctx);
    const input = parse(personalityPreviewSchema, req.body);
    const controller = new AbortController(), close = () => controller.abort();
    streams.add(controller); reply.raw.on('close', close);
    const streaming = String(req.headers.accept).includes('text/event-stream');
    if (streaming) {
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store, no-transform', 'x-accel-buffering': 'no' });
      reply.hijack(); reply.raw.socket?.setNoDelay(true); reply.raw.flushHeaders();
    }
    let checkedAt = 0;
    const write = async (value: AiPersonalityPreviewEvent) => {
      controller.signal.throwIfAborted();
      if (Date.now() - checkedAt >= 200) { runtime.personalities.need(await identity(req, false)); checkedAt = Date.now(); }
      if (!reply.raw.write(`data: ${JSON.stringify(value)}\n\n`)) await new Promise<void>((resolve, reject) => {
        const done = () => { reply.raw.off('drain', done); controller.signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { reply.raw.off('drain', done); reject(new Error('closed')); };
        reply.raw.once('drain', done); controller.signal.addEventListener('abort', abort, { once: true });
      });
    };
    try {
      const result = await runtime.previewPersonality(ctx, input, streaming ? text => write({ type: 'delta', text }) : undefined, controller.signal);
      if (!streaming) return result;
      await write({ type: 'done', result });
    } catch (error) {
      if (!streaming) throw error;
      // 连接器错误可能包含上游正文，试聊只交付稳定错误码。
      if (!controller.signal.aborted) await write({ type: 'error', code: isCageError(error) ? error.code : 'MODEL_PREVIEW_FAILED' }).catch(() => {});
    } finally { streams.delete(controller); reply.raw.off('close', close); if (streaming) reply.raw.end(); }
  });
  app.get('/api/ai/sessions', async req => runtime.sessions(await identity(req)));
  app.post('/api/ai/sessions', async (req, reply) => {
    const body = parse(sessionInputSchema, req.body ?? {});
    return reply.code(201).send(await runtime.createSession(await identity(req), body.title, body.personalityKey));
  });
  app.get('/api/ai/sessions/:id/runs', async req => runtime.runs(await identity(req), (req.params as any).id));
  app.post('/api/ai/sessions/:id/messages', async (req, reply) => {
    const key = parse(z.string().min(1).max(160), req.headers['idempotency-key']);
    const run = await runtime.submit(await identity(req), (req.params as any).id, req.body, key, (req as any).cageSession.id);
    return reply.code(202).send(run);
  });
  app.get('/api/ai/runs/:id', async req => runtime.run(await identity(req), (req.params as any).id));
  app.post('/api/ai/runs/:id/cancel', async req => runtime.cancel(await identity(req), (req.params as any).id));
  app.post('/api/ai/runs/:id/interactions/:interactionId', async req => {
    const p = req.params as any;
    return runtime.respond(await identity(req), p.id, p.interactionId, req.body);
  });
  app.get('/api/ai/memory', async req => runtime.memories(await identity(req)));
  app.delete('/api/ai/memory/:id', async req => { await runtime.deleteMemory(await identity(req), (req.params as any).id); return { ok: true }; });
  app.get('/api/ai/runs/:id/events', async (req, reply) => {
    const id = (req.params as any).id, query = (req.query ?? {}) as any;
    let cursor = parse(z.coerce.number().int().nonnegative(), query.after ?? req.headers['last-event-id'] ?? 0);
    const ctx = await identity(req);
    const initial = await runtime.eventPage(ctx, id, cursor);
    if (!String(req.headers.accept).includes('text/event-stream')) return initial.events;
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store, no-transform', 'x-accel-buffering': 'no' });
    reply.hijack();
    reply.raw.socket?.setNoDelay(true);
    reply.raw.flushHeaders();
    const controller = new AbortController(), endAt = Date.now() + 55_000;
    streams.add(controller);
    const close = () => controller.abort();
    reply.raw.on('close', close);
    try {
      let page = initial;
      while (!controller.signal.aborted && Date.now() < endAt) {
        for (const event of page.events) {
          // 尊重慢消费者背压，不在内存中无限积压事件。
          if (!reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
            await new Promise<void>((resolve, reject) => {
              const done = () => { reply.raw.off('drain', done); controller.signal.removeEventListener('abort', abort); resolve(); };
              const abort = () => { reply.raw.off('drain', done); reject(new Error('closed')); };
              reply.raw.once('drain', done); controller.signal.addEventListener('abort', abort, { once: true });
            });
          }
          cursor = event.sequence;
        }
        if (cursor >= page.nextSequence && (TERMINAL.includes(page.status) || page.status.startsWith('waiting_'))) break;
        // 有积压时立即追赶；在线跟随只增加至多约 100ms 等待，并持续核验会话和权限。
        if (page.events.length < 200) await delay(100, undefined, { signal: controller.signal });
        page = await runtime.eventPage(await identity(req), id, cursor);
      }
    } catch { /* 会话撤销、权限改变或断线立即结束；续连走完整 HTTP 授权。 */ }
    finally { streams.delete(controller); reply.raw.off('close', close); reply.raw.end(); }
  });
}
