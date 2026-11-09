// 真实 PostgreSQL、私有磁盘和 HTTP；重点验证权限、重启恢复、命令回滚及清理竞争。
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, FileService, LocalFileStorage, type CageServer } from '@yss123/cage-http';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';
import * as domain from './fixtures/files.js';

let env: TestEnv, server: CageServer, owner: TestUser, colleague: TestUser, outsider: TestUser, directory: string, cookie: string, csrf: string;
/** 对客户端实际发送片计算小写 SHA-256，故障场景可故意让摘要与流内容不同。 */
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** 小分片配置降低测试成本，仍使用真实磁盘适配器；重建 FileService 必须复用同一路径才能恢复会话。 */
const options = () => ({ domain, urls: env.urls, logger: false as const, admin: false, files: { directory, partBytes: 64 * 1024, maxFileBytes: 2 * 1024 ** 2 } });
/** 独立库和随机临时目录隔离元数据/字节；保留实际 CSRF 流程，区分上传者、同部门和范围外用户。 */
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cage-files-test-'));
  env = await createTestEnv({ domain });
  const caps = ['Document.create', 'Document.read', 'Document.setFiles', 'Document.rename', 'Document.failFiles', 'Document.archive'];
  owner = await env.user({ caps, scopes: { Document: 'dept' } });
  colleague = await env.user({ caps, scopes: { Document: 'dept' } });
  outsider = await env.user({ caps, deptId: await env.dept('外部部门'), scopes: { Document: 'dept' } });
  await env.kernel.execute('User.setPassword', { id: owner.id, password: 'file-test-password' }, env.system());
  server = createServer(options()); await server.ready();
  const token = await server.app.inject({ url: '/auth/csrf' });
  const csrfCookie = cookies(token.headers['set-cookie']); csrf = token.json().token;
  const login = await server.app.inject({ method: 'POST', url: '/auth/login', headers: { cookie: csrfCookie, 'x-csrf-token': csrf }, payload: { username: owner.username, password: 'file-test-password' } });
  expect(login.statusCode).toBe(200);
  cookie = [csrfCookie, cookies(login.headers['set-cookie'])].filter(Boolean).join('; ');
});
/** 先等服务取消在途 IO，再关数据库；递归删除前确认目标仍在系统临时目录内。 */
afterAll(async () => {
  await server?.close(); await env?.close();
  if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep)) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});
/** 提取响应 Cookie 的键值部分供下一次注入请求使用，不把属性误作请求 Cookie。 */
function cookies(raw: string | string[] | undefined) { return [raw].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; '); }
/** 只创建元数据会话；extra 精确控制目标命令/字段/MIME 等反例，不替上传字节或绑定领域对象。 */
async function begin(bytes: Buffer, extra: Record<string, unknown> = {}, service = server.files) {
  return service.begin({ command: 'Document.create', field: 'attachments', filename: '材料.txt', contentType: 'text/plain', bytes: bytes.length, ...extra }, await owner.ctx(), randomUUID());
}
/** 按服务器返回片尺寸完整上传并合并到 ready；返回仍未绑定的临时文件，绑定需另执行业务命令。 */
async function upload(bytes: Buffer, extra: Record<string, unknown> = {}, service = server.files) {
  const session = await begin(bytes, extra, service), ctx = await owner.ctx();
  for (let number = 1; number <= session.partCount; number++) {
    const part = bytes.subarray((number - 1) * session.partBytes, Math.min(number * session.partBytes, bytes.length));
    await service.putPart(session.id, number, hash(part), Readable.from([part]), ctx);
  }
  return service.complete(session.id, ctx);
}

it('分片 HTTP 受登录/CSRF 约束，超过普通 JSON 大小的二进制通过流式路由上传', async () => {
  const bytes = Buffer.alloc(1_300_000, 'a');
  const request = { command: 'Document.create', field: 'attachments', filename: '报价.txt', bytes: bytes.length, contentType: 'text/plain' };
  const unauthorized = await server.app.inject({ method: 'POST', url: '/api/sys/uploads', payload: request });
  expect(unauthorized.statusCode).toBe(403);
  const response = await server.app.inject({ method: 'POST', url: '/api/sys/uploads', payload: request, headers: { cookie, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() } });
  expect(response.statusCode, response.body).toBe(200);
  const session = response.json();
  for (let number = 1; number <= session.partCount; number++) {
    const part = bytes.subarray((number - 1) * session.partBytes, Math.min(number * session.partBytes, bytes.length));
    const result = await server.app.inject({ method: 'POST', url: `/api/sys/uploads/${session.id}/parts/${number}`, payload: part,
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream', 'x-content-sha256': hash(part) } });
    expect(result.statusCode, result.body).toBe(200);
  }
  const completed = await server.app.inject({ method: 'POST', url: `/api/sys/uploads/${session.id}/complete`, payload: {}, headers: { cookie, 'x-csrf-token': csrf } });
  expect(completed.statusCode, completed.body).toBe(200);
  expect(completed.json().status).toBe('ready');
  const download = await server.app.inject({ url: `/api/sys/files/${session.id}/download`, headers: { cookie, range: 'bytes=10-99' } });
  expect(download.statusCode).toBe(206);
  expect(download.rawPayload).toEqual(bytes.subarray(10, 100));
  expect(download.headers['content-disposition']).toContain('filename*=UTF-8');
  expect(download.headers['cache-control']).toContain('no-store');
  const invalid = await server.app.inject({ url: `/api/sys/files/${session.id}/download`, headers: { cookie, range: `bytes=${bytes.length + 1}-` } });
  expect(invalid.statusCode).toBe(416);
});

/** 用新服务实例读取持久化进度，证明续传依据数据库确认片，不能依赖进程内缓存或客户端发送进度。 */
it('校验失败只重传失败分片，幂等片号不允许改变内容；新服务实例恢复确认清单', async () => {
  const bytes = Buffer.alloc(150_000, 'b'), session = await begin(bytes), ctx = await owner.ctx();
  const first = bytes.subarray(0, session.partBytes);
  await expect(server.files.putPart(session.id, 1, hash(first), Readable.from([Buffer.alloc(first.length, 'x')]), ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect((await server.files.get(session.id, ctx)).parts).toEqual([]);
  await server.files.putPart(session.id, 1, hash(first), Readable.from([first]), ctx);
  await server.files.putPart(session.id, 1, hash(first), Readable.from([first]), ctx);
  await expect(server.files.putPart(session.id, 1, hash(Buffer.alloc(first.length, 'x')), Readable.from([first]), ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  const recovered = new FileService(server.kernel, options().files);
  try {
    expect((await recovered.get(session.id, ctx)).parts).toEqual([{ number: 1, bytes: first.length, sha256: hash(first) }]);
    await expect(recovered.complete(session.id, ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
    for (let number = 2; number <= session.partCount; number++) {
      const part = bytes.subarray((number - 1) * session.partBytes, number * session.partBytes);
      await recovered.putPart(session.id, number, hash(part), Readable.from([part]), ctx);
    }
    expect((await recovered.complete(session.id, ctx)).status).toBe('ready');
    expect((await recovered.complete(session.id, ctx)).status).toBe('ready');
    const file = await recovered.download(session.id, ctx);
    const buffers: Buffer[] = []; for await (const part of file.stream) buffers.push(part);
    expect(Buffer.concat(buffers)).toEqual(bytes);
  } finally { await recovered.close(); }
});

/** 同时观察原附件、替换附件状态、主对象版本及审计，证明绑定失败没有半提交或跨用户窃取。 */
it('附件与命令版本/审计/同事务反应共同回滚，重复绑定、跨租户和非上传者提交被拒绝', async () => {
  const ready = await upload(Buffer.from('合同资料')), ctx = await owner.ctx();
  const doc = await env.kernel.execute('Document.create', { title: '事务', attachments: [ready.id] }, ctx);
  expect((await server.files.info(ready.id, await colleague.ctx())).id).toBe(ready.id);
  await expect(server.files.info(ready.id, await outsider.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(server.files.info(ready.id, { ...ctx, tenantId: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(server.files.cancel(ready.id, ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  const replacement = await upload(Buffer.from('替换材料'));
  const failed = await env.callAs(ctx, 'Document.failFiles', { id: doc.id, attachments: [replacement.id] });
  expect(failed).toMatchObject({ ok: false, domainCode: 'REJECT_FILE_CHANGE' });
  expect((await env.kernel.read.get('Document', doc.id, ctx)).attachments).toEqual([ready.id]);
  expect((await server.files.get(replacement.id, ctx)).status).toBe('ready');
  await expect(env.kernel.execute('Document.create', { title: '占用', attachments: [ready.id] }, ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(env.kernel.execute('Document.create', { title: '偷取', attachments: [replacement.id] }, await colleague.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await env.kernel.execute('Document.setFiles', { id: doc.id, attachments: [replacement.id], expectedVersion: 1 }, ctx);
  expect((await server.files.get(ready.id, ctx)).status).toBe('ready');
  expect((await env.kernel.read.get('Document', doc.id, ctx)).version).toBe(2);
  await env.kernel.execute('Document.rename', { id: doc.id, title: '仅改标题' }, await colleague.ctx());
  expect((await env.kernel.read.get('Document', doc.id, ctx)).attachments).toEqual([replacement.id]);
  expect(await env.audit({ aggregateId: doc.id, kind: 'write' })).toHaveLength(3);
});

it('新会话核对命令、字段、目标状态和范围；当前撤权影响下载与续传', async () => {
  const ctx = await owner.ctx(), bytes = Buffer.from('授权测试'), ready = await upload(bytes);
  await expect(begin(bytes, { command: 'Document.rename' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(server.files.get(ready.id, await colleague.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(server.files.get(ready.id, { ...ctx, capabilities: new Map() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const doc = await env.kernel.execute('Document.create', { title: '授权', attachments: [ready.id] }, ctx);
  await expect(server.files.info(ready.id, { ...ctx, capabilities: new Map() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(begin(bytes, { command: 'Document.setFiles', targetId: doc.id }, new FileService(server.kernel, options().files))).resolves.toMatchObject({ targetId: doc.id });
  await env.kernel.execute('Document.archive', { id: doc.id }, ctx);
  await expect(begin(bytes, { command: 'Document.setFiles', targetId: doc.id })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
});

it('到期清理不会删除已绑定文件；先认领清理后绑定必定失败，取消可幂等重试', async () => {
  const ctx = await owner.ctx(), ready = await upload(Buffer.from('清理竞争'));
  const bound = await upload(Buffer.from('已绑定保留'));
  await env.kernel.execute('Document.create', { title: '保留', attachments: [bound.id] }, ctx);
  await env.query("update sys.file_upload set expires_at=now()-interval '1 second' where id=$1", [bound.id]);
  await server.files.cleanup();
  expect((await server.files.info(bound.id, ctx)).id).toBe(bound.id);
  await server.files.cancel(ready.id, ctx); await server.files.cancel(ready.id, ctx);
  await expect(env.kernel.execute('Document.create', { title: '太晚', attachments: [ready.id] }, ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  await server.files.cleanup();
  expect((await env.query('select status from sys.file_upload where id=$1', [ready.id]))[0].status).toBe('deleted');
  await expect(stat(join(directory, ready.id))).rejects.toMatchObject({ code: 'ENOENT' });
});

/** Promise 屏障把执行精确停在元数据已认领、字节未删除处；finally 解锁并恢复 spy，避免不确定竞态。 */
it('清理已认领且磁盘删除尚未结束时，业务绑定不能把文件重新救回', async () => {
  const ctx = await owner.ctx(), ready = await upload(Buffer.from('清理认领屏障'));
  await env.query("update sys.file_upload set expires_at=now()-interval '1 second' where id=$1", [ready.id]);
  let entered!: () => void, release!: () => void;
  const deleting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = server.files.storage.remove.bind(server.files.storage);
  const spy = vi.spyOn(server.files.storage, 'remove').mockImplementation(async id => {
    if (id === ready.id) { entered(); await gate; }
    return original(id);
  });
  const cleanup = server.files.cleanup();
  try {
    await deleting;
    expect((await env.query('select status from sys.file_upload where id=$1', [ready.id]))[0].status).toBe('deleting');
    await expect(env.kernel.execute('Document.create', { title: '清理中不能关联', attachments: [ready.id] }, ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally { release(); await cleanup; spy.mockRestore(); }
  expect((await env.query('select status from sys.file_upload where id=$1', [ready.id]))[0].status).toBe('deleted');
});

/** 控制旧适配器写入延迟并只修改测试租约时间，新 token 完成后再释放旧执行者，检查确认栅栏。 */
it('过期分片租约被新实例接管后，迟到的旧执行者不能覆盖确认清单', async () => {
  const bytes = Buffer.from('租约接管'), ctx = await owner.ctx(), session = await begin(bytes);
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const storage = server.files.storage, original = storage.writePart.bind(storage);
  const spy = vi.spyOn(storage, 'writePart').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
  const oldWrite = server.files.putPart(session.id, 1, hash(bytes), Readable.from([bytes]), ctx);
  const oldRejected = expect(oldWrite).rejects.toMatchObject({ code: 'CONFLICT' });
  const recovered = new FileService(server.kernel, options().files);
  try {
    await writing;
    await env.query("update sys.file_part set lease_until=now()-interval '1 second' where upload_id=$1", [session.id]);
    await recovered.putPart(session.id, 1, hash(bytes), Readable.from([bytes]), ctx);
    release(); await oldRejected;
    expect((await recovered.get(session.id, ctx)).parts).toEqual([{ number: 1, bytes: bytes.length, sha256: hash(bytes) }]);
    expect((await recovered.complete(session.id, ctx)).status).toBe('ready');
    await recovered.cleanup();
    expect((await readdir(join(directory, session.id))).filter(name => name.startsWith('part-'))).toEqual([]);
  } finally { release(); await oldWrite.catch(() => {}); spy.mockRestore(); await recovered.close(); }
});

/** 分别攻击声明配额、内容伪装和绑定数量；下载审计故障必须拒绝，不能以无审计流兜底成功。 */
it('系统配额、文件数量及内容类型由服务端拒绝；可靠下载审计失败不交付流', async () => {
  const ctx = await owner.ctx();
  const limited = new FileService(server.kernel, { ...options().files, maxPendingBytesPerUser: 1 });
  await expect(begin(Buffer.from('quota'), {}, limited)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  await limited.close();
  const forged = await begin(Buffer.from('this is not a pdf'), { filename: '伪造.pdf', field: 'cover', contentType: 'application/pdf' });
  const content = Buffer.from('this is not a pdf');
  await server.files.putPart(forged.id, 1, hash(content), Readable.from([content]), ctx);
  await expect(server.files.complete(forged.id, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const files = await Promise.all([1, 2, 3, 4].map(i => upload(Buffer.from(`数量${i}`))));
  await expect(env.kernel.execute('Document.create', { title: '超量', attachments: files.map(f => f.id) }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const spy = vi.spyOn(server.kernel, 'writeAudit').mockRejectedValueOnce(new Error('audit unavailable'));
  try { await expect(server.files.download(files[0].id, ctx)).rejects.toThrow('audit unavailable'); } finally { spy.mockRestore(); }
});

/** 输入流半途停住时检查临时文件已有字节，提供流式写入证据；该场景不测机器吞吐或内存峰值。 */
it('磁盘上传在源结束前写出数据，合并按流校验，避免整文件缓冲', async () => {
  const storage = new LocalFileStorage(directory), uploadId = randomUUID(), token = randomUUID();
  const chunk = Buffer.alloc(64 * 1024, 'z'), chunks = 64, checksum = createHash('sha256');
  for (let i = 0; i < chunks; i++) checksum.update(chunk);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = Readable.from((async function* () { for (let i = 0; i < chunks; i++) { if (i === 32) await gate; yield chunk; } })());
  const writing = storage.writePart(uploadId, token, source, { bytes: chunk.length * chunks, sha256: checksum.digest('hex'), signal: new AbortController().signal });
  try {
    await vi.waitFor(async () => {
      const entries = await readdir(join(directory, uploadId));
      const temporary = entries.find(name => name.endsWith('.tmp'));
      expect(temporary).toBeTruthy(); expect((await stat(join(directory, uploadId, temporary!))).size).toBeGreaterThan(0);
    });
  } finally { release(); }
  const key = await writing;
  expect((await stat(join(directory, key))).size).toBe(chunk.length * chunks);
  await storage.remove(uploadId);
});
