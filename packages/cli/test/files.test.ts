import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { aggregate, buildRegistry, command, event, file, files, id, list, scope, text } from '@yss123/cage-kernel';
import { z } from 'zod';
import { CageClient } from '../../client/src/index.js';
import type { UploadSession } from '../../client/src/files.js';
import { contractsFiles } from '../src/gen/contracts.js';
import { extract } from '../src/ontology.js';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const target = { command: 'Document.create', field: 'attachments' };
function session(parts: UploadSession['parts'] = []): UploadSession {
  return { id: randomUUID(), aggregate: 'Document', field: 'attachments', command: 'Document.create', targetId: null, filename: 'same.txt', bytes: 12,
    contentType: 'text/plain', status: 'uploading', partBytes: 4, partCount: 3, parts, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

it('文件声明拒绝不安全组合，契约与本体保留字段限制及 ID 类型', () => {
  expect(() => file({ maxBytes: 0, accept: ['*/*'] })).toThrow('CAGE-FILE-001');
  expect(() => files({ maxBytes: 100, accept: ['text/plain'], maxCount: 0 })).toThrow('CAGE-FILE-001');
  expect(() => list(file({ maxBytes: 100, accept: ['text/plain'] }))).toThrow('CAGE-FILE-001');
  expect(() => file({ maxBytes: 100, accept: ['text/plain'] }).sensitive('name')).toThrow('CAGE-FILE-001');
  expect(() => event('BadFile', { document: file({ maxBytes: 100, accept: ['text/plain'] }) })).toThrow('CAGE-FILE-001');
  const Document = aggregate('Document', { fields: { title: text(), attachment: file({ maxBytes: 100, accept: ['text/plain'] }).optional(), attachments: files({ maxBytes: 100, maxCount: 3, accept: ['text/plain'] }) } });
  expect(() => aggregate('BadScope', { fields: { owner: file({ maxBytes: 100, accept: ['text/plain'] }) }, scope: scope.self('owner') })).toThrow('CAGE-FILE-001');
  const create = command(Document, { from: 'new', to: 'active', input: z.object({ title: z.string(), attachments: z.array(z.string().uuid()) }), handler: draft => draft });
  const reg = buildRegistry({ Document, create }), generated = contractsFiles(reg, []);
  expect(generated['aggregates/document/index.ts']).toContain('attachments: z.array(z.string().uuid()).max(3)');
  expect(generated['aggregates/document/index.ts']).toContain('DocumentFileFields');
  expect(extract(reg).nodes.find(n => n.id === 'Document.attachments')?.attrs.filePolicy).toEqual({ maxBytes: 100, maxCount: 3, accept: ['text/plain'] });
  expect(event('FileReference', { fileId: id() }).schema.safeParse({ fileId: randomUUID() }).success).toBe(true);
});

it('续传逐片核对内容，只发送缺失片；网络失败只重试该片，进度以服务端确认为准', async () => {
  const s = session([{ number: 1, bytes: 4, sha256: digest('aaaa') }]);
  const sent: number[] = []; let retry = true, inFlight = 0, maximum = 0;
  const client = new CageClient({ fetch: (async (url, options) => {
    const path = String(url);
    if (path.endsWith('/auth/csrf')) return response({ token: 'csrf' });
    if (path.endsWith(`/uploads/${s.id}`)) return response(s);
    if (path.endsWith('/complete')) return response({ ...s, status: 'ready' });
    const number = Number(path.split('/').at(-1)); sent.push(number);
    inFlight++; maximum = Math.max(maximum, inFlight);
    const body = await (options!.body as Blob).text();
    inFlight--;
    expect((options!.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    expect((options!.headers as Record<string, string>)['x-content-sha256']).toBe(digest(body));
    if (number === 2 && retry) { retry = false; throw new Error('offline'); }
    return response({ number, bytes: body.length, sha256: digest(body) });
  }) as typeof fetch });
  const task = client.upload(new File(['aaaabbbbcccc'], 'same.txt', { type: 'text/plain' }), target, { uploadId: s.id, concurrency: 2, retries: 1 });
  try {
    expect((await task.start()).status).toBe('ready');
    expect(sent.filter(n => n === 1)).toHaveLength(0);
    expect(sent.filter(n => n === 2)).toHaveLength(2);
    expect(sent.filter(n => n === 3)).toHaveLength(1);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(task.getSnapshot()).toMatchObject({ status: 'completed', confirmedBytes: 12 });
  } finally { task.dispose(); }
});

it('刷新后同名同尺寸的不同文件不能混入已上传分片', async () => {
  const s = session([{ number: 1, bytes: 4, sha256: digest('aaaa') }]);
  let writes = 0;
  const client = new CageClient({ fetch: (async (_url, options) => { if (options?.method === 'POST') writes++; return response(s); }) as typeof fetch });
  const task = client.upload(new File(['xxxxbbbbcccc'], 'same.txt', { type: 'text/plain' }), target, { uploadId: s.id });
  try { await expect(task.start()).rejects.toThrow('内容不一致'); expect(writes).toBe(0); } finally { task.dispose(); }
});

it('暂停与账号切换中断在途分片，继续时从服务端清单恢复', async () => {
  const s = session();
  let notify!: () => void, paused = true;
  let started = new Promise<void>(resolve => { notify = resolve; });
  const client = new CageClient({ fetch: (async (url, options) => {
    const path = String(url);
    if (path.endsWith('/auth/csrf')) return response({ token: 'csrf' });
    if (path.endsWith(`/uploads/${s.id}`)) return response(s);
    if (path.endsWith('/complete')) return response({ ...s, status: 'ready' });
    notify();
    if (paused) return new Promise((_resolve, reject) => {
      if (options?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    return response({ number: Number(path.split('/').at(-1)), bytes: 4, sha256: digest(await (options!.body as Blob).text()) });
  }) as typeof fetch });
  const task = client.upload(new File(['aaaabbbbcccc'], 'same.txt', { type: 'text/plain' }), target, { uploadId: s.id, concurrency: 1 });
  try {
    const first = task.start(); const rejected = expect(first).rejects.toBeDefined(); await started; task.pause(); await rejected;
    expect(task.getSnapshot().status).toBe('paused');
    started = new Promise<void>(resolve => { notify = resolve; });
    const second = task.start(); const rejectedAgain = expect(second).rejects.toBeDefined(); await started; client.clearSession('account-switch'); await rejectedAgain;
    expect(task.getSnapshot().status).toBe('paused');
    paused = false;
    expect((await task.start()).status).toBe('ready');
  } finally { task.dispose(); }
});
