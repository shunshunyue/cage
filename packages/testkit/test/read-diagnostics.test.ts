/**
 * 读侧与运维诊断的真实 PostgreSQL/HTTP 回归，保护输入边界、敏感读取审计、数据范围及证据隔离。
 * 构造不同用户、范围、授权和同 UUID 的跨聚合记录，确保诊断不能成为越权读取或执行命令的旁路。
 * 测试直查系统表仅用于核对持久证据；服务端接口仍使用正常授权。每例恢复 mock，最终关闭服务及隔离库。
 */
// 读取与运维诊断使用真实安全视图，验证拒绝交付、隔离与证据关联，不通过诊断写业务。
import { randomUUID } from 'node:crypto';
import * as adminDomain from '@yss123/cage-admin/domain';
import {
  aggregate, bool, ceiling, command, createKernel, date, emit, event, hasMany, id, int, list, money, silentLogger,
  query, ref, scope, states, text, type Ctx,
} from '@yss123/cage-kernel';
import { createServer, type CageServer } from '@yss123/cage-http';
import { createWorker } from '@yss123/cage-kernel/worker';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

/**
 * 本人范围的父对象，children 通过子记录外键反查；与记录复用 ID 的场景用于检验关联条件包含聚合名。
 */
const DiagnosticFolder = aggregate('DiagnosticFolder', {
  fields: { ownerId: ref('User'), title: text(30), children: hasMany('DiagnosticRecord', { mappedBy: 'folderId' }) },
  scope: scope.self('ownerId'),
});
/**
 * 综合字段夹具：金额、布尔、日期、整数和列表检验严格输入，phone 检验掩码排序及明文审计。
 * ownerId/teamId 是自定义范围字段，不能假设所有聚合都有 createdBy/deptId。
 */
const DiagnosticRecord = aggregate('DiagnosticRecord', {
  fields: { ownerId: ref('User'), teamId: ref('Dept'), folderId: ref(DiagnosticFolder).optional(), amount: money(), phone: text(32).sensitive('phone'), active: bool(), on: date(), quantity: int(), label: text(12), flags: list(text()).optional() },
  states: states('draft', 'approved', { terminal: ['approved'] }),
  scope: scope.of({ owner: 'ownerId', dept: 'teamId' }),
});
const RecordCreated = event('DiagnosticRecordCreated', { recordId: id(), note: text() });
const FolderCreated = event('DiagnosticFolderCreated', { folderId: id() });
const createInput = z.object({ id: z.uuid().optional(), teamId: z.uuid().optional(), ownerId: z.uuid().optional(), folderId: z.uuid().optional(), amount: z.string().default('100'), phone: z.string().default('13812345678'), active: z.boolean().default(false), on: z.string().default('2026-11-03'), quantity: z.number().int().default(2), label: z.string().default('sample') });
const createRecord = command(DiagnosticRecord, {
  name: 'create', from: 'new', to: 'draft', input: createInput, handler: (draft) => draft,
  emits: [emit(RecordCreated, (record) => ({ recordId: record.id, note: 'SYNTHETIC_PRIVATE_PAYLOAD' }))],
});
const createFolder = command(DiagnosticFolder, {
  name: 'create', from: 'new', to: 'active', input: z.object({ id: z.uuid().optional(), title: z.string() }), handler: (draft) => draft,
  emits: [emit(FolderCreated, (record) => ({ folderId: record.id }))],
});
const approveRecord = command(DiagnosticRecord, { name: 'approve', from: 'draft', to: 'approved', constraints: [ceiling('amount')], handler: (draft) => draft });
const internalReview = command(DiagnosticRecord, { name: 'internalReview', from: 'draft', to: 'draft', invokedBy: 'process', handler: (draft) => draft });
/**
 * 故意将敏感字段拼进约束失败原文，测试诊断响应会裁剪细节，不能把内部错误直接透传。
 */
const privateConstraint = command(DiagnosticRecord, {
  name: 'privateConstraint', from: 'draft', to: 'draft', handler: (draft) => draft,
  constraints: [{ name: 'privateBusinessRule', fields: ['phone'], check: (draft: any) => ({ ok: false, message: `SYNTHETIC_PRIVATE_CONSTRAINT:${draft.phone}` }) }],
});
let checkedHandlerCalls = 0;
/**
 * 约束核对 handler 前的真实创建草稿，handler 计数用于证明 explain 不执行业务处理。
 */
const createChecked = command(DiagnosticRecord, {
  name: 'createChecked', from: 'new', to: 'draft', input: createInput,
  constraints: [{ name: 'preHandlerDraft', fields: ['ownerId', 'teamId'], check: (draft: any, ctx: Ctx) => draft.ownerId === null && draft.teamId === ctx.deptId && !('createdBy' in draft) && !('deptId' in draft) ? { ok: true } : { ok: false, message: '草稿默认值不同' } }],
  handler: (draft) => { checkedHandlerCalls++; return draft; },
});
/**
 * 未声明用途审计的安全视图查询，与 auditedRows 对比明文审计和用途审计的独立触发条件。
 */
const plainRows = query('diagnosticPlainRows', { reads: [DiagnosticRecord], sql: 'select id, phone from safe.diagnostic_record' });
/**
 * 显式用途审计查询；即使结果为掩码，审计失败也不能交付查询数据。
 */
const auditedRows = query('diagnosticAuditedRows', { reads: [DiagnosticRecord], sql: 'select id, phone from safe.diagnostic_record', audit: { purpose: '诊断回归的用途级读取' } });
const domain = { ...adminDomain, DiagnosticFolder, DiagnosticRecord, RecordCreated, FolderCreated, createFolder, createRecord, approveRecord, internalReview, privateConstraint, createChecked, plainRows, auditedRows };

let env: TestEnv, server: CageServer, owner: TestUser, other: TestUser, ops: TestUser, noOps: TestUser;
let folder: Record<string, any>, mine: Record<string, any>, outside: Record<string, any>;
const cookies = new Map<string, string>();
const sharedRequest = 'diagnostic-shared-request';
beforeAll(async () => {
  env = await createTestEnv({ domain });
  const business = ['DiagnosticRecord.create', 'DiagnosticRecord.createChecked', 'DiagnosticRecord.read', 'DiagnosticRecord.approve', 'DiagnosticRecord.internalReview', 'DiagnosticRecord.privateConstraint', 'DiagnosticFolder.create', 'DiagnosticFolder.read'];
  owner = await env.user({ caps: [...business, 'Sys.ops.read', 'Sys.audit.read'] });
  other = await env.user({ caps: business });
  ops = await env.user({ caps: 'all', scopes: { '*': 'all' }, params: { 'DiagnosticRecord.approve': { ceiling: 1000 } } });
  noOps = await env.user({ caps: ['DiagnosticRecord.read'] });
  const ownerCtx = { ...await owner.ctx(), requestId: sharedRequest };
  // 跨聚合有意复用 UUID，证明审计关联不只依赖 aggregate_id。
  const sameId = randomUUID();
  folder = await env.kernel.execute('DiagnosticFolder.create', { id: sameId, title: 'private-folder' }, ownerCtx);
  mine = await env.kernel.execute('DiagnosticRecord.create', { id: sameId, folderId: folder.id }, ownerCtx);
  outside = await env.kernel.execute('DiagnosticRecord.create', {}, { ...await other.ctx(), requestId: sharedRequest });
  for (const user of [owner, other, ops, noOps]) await env.kernel.execute('User.setPassword', { id: user.id, password: 'diagnostic-test-password' }, env.system());
  server = createServer({ domain, urls: env.urls, logger: false, csrf: false, authRateLimitPerMinute: 1000 });
  await server.ready();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await server?.close(); await env?.close(); });

/**
 * 按测试用户缓存真实登录 Cookie，再调用被测 HTTP 路由；提供 payload 时发送 POST，否则发送 GET。
 * 缓存仅在本测试文件存活，避免重复密码派生影响诊断用例耗时。
 */
async function http(user: TestUser, url: string, payload?: object) {
  if (!cookies.has(user.id)) {
    const login = await server.app.inject({ method: 'POST', url: '/auth/login', payload: { username: user.username, password: 'diagnostic-test-password' } });
    expect(login.statusCode).toBe(200);
    cookies.set(user.id, [login.headers['set-cookie']].flat().filter(Boolean).map((value) => String(value).split(';')[0]).join('; '));
  }
  return server.app.inject({ method: payload ? 'POST' : 'GET', url, payload, headers: { cookie: cookies.get(user.id)! } });
}

describe('严格列表输入', () => {
  const invalid: [Record<string, unknown>, string][] = [
    [{ page: 1.2 }, 'page'], [{ page: 'Infinity' }, 'page'], [{ page: '0' }, 'page'], [{ page: '-1' }, 'page'],
    [{ pageSize: '1.1' }, 'pageSize'], [{ pageSize: Number.NaN }, 'pageSize'], [{ page: Number.MAX_SAFE_INTEGER, pageSize: 200 }, 'page'],
    [{ createdAfter: '2026-02-30' }, 'createdAfter'], [{ createdBefore: 'yesterday' }, 'createdBefore'],
    [{ createdAfter: '2026-11-03', createdBefore: '2026-11-02' }, 'createdBefore'],
    [{ active: 'FALSE' }, 'active'], [{ active: '0' }, 'active'], [{ active: [] }, 'active'], [{ active: '' }, 'active'],
    [{ quantity: 'Infinity' }, 'quantity'], [{ quantity: '2.5' }, 'quantity'], [{ quantity: {} }, 'quantity'], [{ quantity: '' }, 'quantity'],
    [{ on: '2026-02-30' }, 'on'], [{ label: 'x'.repeat(13) }, 'label'], [{ status: 'made-up' }, 'status'],
    [{ sort: {} }, 'sort'], [{ sort: 'hidden' }, 'sort'], [{ sort: 'flags' }, 'sort'], [{ unregistered: 'value' }, 'unregistered'],
  ];
  it.each(invalid)('拒绝非法参数 %j', async (params, path) => {
    await expect(env.kernel.read.list(DiagnosticRecord, params, await owner.ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT', detail: [{ path }] });
  });
  it('合法字符串布尔、整数、日期可筛选；pageSize保留公开上限', async () => {
    const result = await env.kernel.read.list(DiagnosticRecord, { active: 'false', quantity: '2', on: '2026-11-03', page: '1', pageSize: '999', sort: '-createdAt' }, await owner.ctx());
    expect(result.items.map((row) => row.id)).toEqual([mine.id]);
    expect(result.pageSize).toBe(200);
  });
});

it('非法UUID在SQL执行前拒绝，详情与关联不把数据库类型错误交给调用方', async () => {
  const ctx = await owner.ctx();
  const query = vi.spyOn(env.kernel.readDb, 'transaction');
  await expect(env.kernel.read.get(DiagnosticRecord, '------------------------------------', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(env.kernel.read.related(DiagnosticFolder, '------------------------------------', 'children', {}, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(query).not.toHaveBeenCalled();
});

it('敏感 get/list/related/query 在审计存储失败时均拒绝交付，掩码读取不依赖明文审计', async () => {
  const raw = await ops.ctx();
  const audit = vi.spyOn(env.kernel, 'writeAudit').mockRejectedValue(new Error('synthetic audit unavailable'));
  for (const operation of [
    () => env.kernel.read.get(DiagnosticRecord, mine.id, raw),
    () => env.kernel.read.list(DiagnosticRecord, {}, raw),
    () => env.kernel.read.related(DiagnosticFolder, folder.id, 'children', {}, raw),
    () => env.kernel.read.run(plainRows, {}, raw),
  ]) await expect(operation()).rejects.toMatchObject({ code: 'INTERNAL', detail: { diagnostic: 'CAGE-AUDIT-001', phase: 'audit' } });
  audit.mockRestore();
  const visible = await env.kernel.read.get(DiagnosticRecord, mine.id, await owner.ctx());
  expect(visible.phone).toBe('138****5678');
  const deniedAudit = vi.spyOn(env.kernel, 'writeAudit').mockRejectedValue(new Error('synthetic audit unavailable'));
  expect((await env.kernel.read.get(DiagnosticRecord, mine.id, await owner.ctx())).phone).toBe('138****5678');
  expect(deniedAudit).not.toHaveBeenCalled();
});

it('query用途级审计保存用途和行数，不记录SQL结果；审计失败即使读取掩码也不交付', async () => {
  const ctx = { ...await owner.ctx(), requestId: 'diagnostic-query-purpose' };
  const result = await env.kernel.read.run(auditedRows, {}, ctx);
  expect(result[0].phone).toBe('138****5678');
  const [entry] = await env.query("select diff from sys.audit_log where request_id=$1 and capability=$2", [ctx.requestId, 'query:diagnosticAuditedRows']);
  expect(entry.diff).toMatchObject({ purpose: '诊断回归的用途级读取', rows: 1, reads: ['DiagnosticRecord'] });
  expect(JSON.stringify(entry.diff)).not.toContain('13812345678');
  vi.spyOn(env.kernel, 'writeAudit').mockRejectedValue(new Error('synthetic audit unavailable'));
  await expect(env.kernel.read.run(auditedRows, {}, ctx)).rejects.toMatchObject({ code: 'INTERNAL', detail: { diagnostic: 'CAGE-AUDIT-001' } });
});

it('权限解释区分能力、范围、额度、身份、版本且不执行命令或写审计', async () => {
  const before = (await env.query('select count(*)::int as n from sys.audit_log'))[0].n;
  const ownerCtx = await owner.ctx(), opsCtx = await ops.ctx();
  const missing = await env.kernel.explain('DiagnosticRecord.approve', { id: mine.id }, await noOps.ctx());
  expect(missing.checks).toContainEqual(expect.objectContaining({ stage: 'capability', status: 'fail' }));
  const scopeFailure = await env.kernel.explain('DiagnosticRecord.approve', { id: outside.id }, ownerCtx);
  expect(scopeFailure.checks).toContainEqual(expect.objectContaining({ stage: 'scope', status: 'fail', code: 'NOT_FOUND' }));
  const ceilingFailure = await env.kernel.explain('DiagnosticRecord.approve', { id: mine.id }, ownerCtx);
  expect(ceilingFailure.checks).toContainEqual(expect.objectContaining({ stage: 'constraint:ceiling(amount)', status: 'fail' }));
  const identityFailure = await env.kernel.explain('DiagnosticRecord.internalReview', { id: mine.id }, ownerCtx);
  expect(identityFailure.checks).toContainEqual(expect.objectContaining({ stage: 'invoker', status: 'fail' }));
  const good = await env.kernel.explain('DiagnosticRecord.approve', { id: mine.id, expectedVersion: String(mine.version) }, opsCtx);
  expect(good.allowed).toBe(true);
  const conflict = await env.kernel.explain('DiagnosticRecord.approve', { id: mine.id, expectedVersion: mine.version + 1 }, opsCtx);
  expect(conflict.checks).toContainEqual(expect.objectContaining({ stage: 'version', status: 'fail', code: 'CONFLICT' }));
  const wrongVersion = await env.kernel.explain('DiagnosticRecord.approve', { id: mine.id, expectedVersion: 'bad' }, opsCtx);
  expect(wrongVersion.checks).toContainEqual(expect.objectContaining({ stage: 'input', status: 'fail', code: 'INVALID_INPUT' }));
  expect((await env.query('select status,version from core.diagnostic_record where id=$1', [mine.id]))[0]).toMatchObject({ status: 'draft', version: mine.version });
  expect((await env.query('select count(*)::int as n from sys.audit_log'))[0].n).toBe(before);
  const confidential = await env.kernel.explain('DiagnosticRecord.privateConstraint', { id: mine.id }, ownerCtx);
  expect(confidential.checks).toContainEqual(expect.objectContaining({ stage: 'constraint:privateBusinessRule', status: 'fail' }));
  expect(JSON.stringify(confidential)).not.toContain('SYNTHETIC_PRIVATE_CONSTRAINT');
  expect(JSON.stringify(confidential)).not.toContain('13812345678');
});

it('新建诊断使用真实pre-handler草稿，不预测handler后范围，不执行handler', async () => {
  const before = checkedHandlerCalls;
  const result = await env.kernel.explain('DiagnosticRecord.createChecked', {}, await owner.ctx());
  expect(result.allowed).toBeNull();
  expect(result.checks).toContainEqual(expect.objectContaining({ stage: 'scope', status: 'not-inspected' }));
  expect(result.checks).toContainEqual(expect.objectContaining({ stage: 'constraint:preHandlerDraft', status: 'pass' }));
  expect(checkedHandlerCalls).toBe(before);
  await env.kernel.execute('DiagnosticRecord.createChecked', {}, await owner.ctx());
  expect(checkedHandlerCalls).toBe(before + 1);
});

it('诊断HTTP要求运维能力；对象与被诊断用户均受租户、读能力及范围限制', async () => {
  expect((await server.app.inject({ url: '/api/sys/diagnostics' })).statusCode).toBe(401);
  expect((await http(noOps, '/api/sys/diagnostics')).statusCode).toBe(403);
  const snapshot = await http(owner, '/api/sys/diagnostics');
  expect(snapshot.statusCode).toBe(200);
  expect(snapshot.json()).toMatchObject({ role: 'api', migrations: { applied: expect.any(Array) }, registryHash: expect.any(String) });
  const endpoint = '/api/sys/diagnostics/authorization';
  expect((await http(owner, endpoint, { command: 'DiagnosticRecord.approve', input: { id: outside.id } })).statusCode).toBe(404);
  expect((await http(owner, endpoint, { command: 'DiagnosticRecord.approve', input: { id: 'invalid-object-id' } })).statusCode).toBe(404);
  expect((await http(owner, endpoint, { command: 'DiagnosticRecord.approve', input: { id: mine.id }, userId: other.id })).statusCode).toBe(404);
  const foreignTenant = { ...env.system(), tenantId: randomUUID() };
  const foreign = await env.kernel.execute('DiagnosticRecord.create', { ownerId: owner.id, teamId: env.rootDeptId }, foreignTenant);
  expect((await http(ops, endpoint, { command: 'DiagnosticRecord.approve', input: { id: foreign.id } })).statusCode).toBe(404);
  const allowed = await http(ops, endpoint, { command: 'DiagnosticRecord.approve', input: { id: mine.id } });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().allowed).toBe(true);
  const hiddenReason = await http(owner, endpoint, { command: 'DiagnosticRecord.privateConstraint', input: { id: mine.id } });
  expect(hiddenReason.statusCode).toBe(200);
  expect(hiddenReason.body).not.toContain('13812345678');
  expect(hiddenReason.body).not.toContain('SYNTHETIC_PRIVATE_CONSTRAINT');
});

it('时间线只返回范围内的持久证据，不返回载荷、远端响应、错误原文或同UUID的其他聚合审计', async () => {
  const [outbox] = await env.query("select id from sys.outbox where aggregate='DiagnosticRecord' and aggregate_id=$1", [mine.id]);
  const marker = 'SYNTHETIC_PRIVATE_PAYLOAD';
  await env.query("update sys.outbox set status='dead',last_error=$1 where id=$2", [`[CAGE-WORKER-002] ${marker}`, outbox.id]);
  await env.query('insert into sys.processed_event(event_id,consumer) values($1,$2)', [outbox.id, 'diagnostic-consumer']);
  await env.query("insert into sys.connector_execution(tenant_id,connector,operation,idempotency_key,request_hash,status,response,error,outbox_id,consumer) values($1,'diagnostic','call','test','hash','unknown',$2,$3,$4,'diagnostic-consumer')", [env.tenantId, JSON.stringify({ secret: marker }), marker, outbox.id]);
  await env.query("insert into sys.dead_letter(tenant_id,outbox_id,event,aggregate_id,payload,error,attempts) values($1,$2,'DiagnosticRecordCreated',$3,$4,$5,1)", [env.tenantId, outbox.id, mine.id, JSON.stringify({ secret: marker }), marker]);
  // 操作人可读自己的Record，移除Folder.read，验证跨聚合复用UUID不会串入其审计。
  await env.kernel.execute('Role.revokeCapability', { id: owner.roleId, capability: 'DiagnosticFolder.read' }, env.system());
  await expect.poll(async () => (await http(owner, '/api/me')).json().capabilities.includes('DiagnosticFolder.read')).toBe(false);
  const result = await http(owner, `/api/sys/diagnostics/timeline?requestId=${sharedRequest}`);
  expect(result.statusCode).toBe(200);
  const timeline = result.json();
  expect(timeline.events).toHaveLength(1);
  expect(timeline.events[0]).toMatchObject({ aggregate: 'DiagnosticRecord', aggregate_id: mine.id, last_error: { code: 'CAGE-WORKER-002' }, consumers: [expect.objectContaining({ consumer: 'diagnostic-consumer' })], calls: [expect.objectContaining({ status: 'unknown' })] });
  expect(timeline.events[0].nextAction).toContain('当前无通用解除 unknown 入口');
  expect(timeline.events[0].nextAction).toContain('普通死信重放不会解除');
  expect(timeline.events[0].nextAction).toContain('连接器专用受控恢复或业务补偿');
  expect(timeline.audit.length).toBeGreaterThan(0);
  expect(timeline.audit.every((entry: any) => entry.aggregate === 'DiagnosticRecord' && entry.aggregate_id === mine.id)).toBe(true);
  expect(result.body).not.toContain(marker);
  expect(timeline.events[0]).not.toHaveProperty('payload');
  expect(timeline.events[0].calls[0]).not.toHaveProperty('response');
  const denied = await http(owner, `/api/sys/diagnostics/timeline?aggregate=DiagnosticRecord&aggregateId=${outside.id}`);
  expect(denied.json()).toMatchObject({ events: [], audit: [], truncated: false });
  const foreignRequest = 'foreign-tenant-timeline';
  await env.query("insert into sys.outbox(tenant_id,event,aggregate,aggregate_id,payload,request_id) values($1,'DiagnosticRecordCreated','DiagnosticRecord',$2,'{}',$3)", [randomUUID(), mine.id, foreignRequest]);
  expect((await http(ops, `/api/sys/diagnostics/timeline?requestId=${foreignRequest}`)).json().events).toEqual([]);
});

it('先过滤不可见事件再分页；大量范围外证据不会挤掉本人事件或泄露截断数量', async () => {
  const requestId = 'diagnostic-hidden-pagination';
  await env.query("insert into sys.outbox(tenant_id,event,aggregate,aggregate_id,payload,request_id) select $1,'DiagnosticRecordCreated','DiagnosticRecord',$2,'{}',$3 from generate_series(1,201)", [env.tenantId, outside.id, requestId]);
  const hiddenOnly = await http(owner, `/api/sys/diagnostics/timeline?requestId=${requestId}`);
  expect(hiddenOnly.json()).toMatchObject({ events: [], truncated: false });
  await env.query("insert into sys.outbox(tenant_id,event,aggregate,aggregate_id,payload,request_id) values($1,'DiagnosticRecordCreated','DiagnosticRecord',$2,'{}',$3)", [env.tenantId, mine.id, requestId]);
  const result = await http(owner, `/api/sys/diagnostics/timeline?requestId=${requestId}`);
  expect(result.json().events).toHaveLength(1);
  expect(result.json().events[0].aggregate_id).toBe(mine.id);
  expect(result.json().truncated).toBe(false);
});

it('运行状态总览隐藏worker错误原文和未声明的运行明细', async () => {
  const marker = 'SYNTHETIC_WORKER_PRIVATE_MARKER';
  const manifest = { version: '0.2.0', registryFingerprint: 'test', consumers: [], events: [], jobs: [] };
  await env.query("insert into sys.worker_runtime(id,pid,registry_fingerprint,manifest,status,details) values($1,1,'test',$2,'error',$3)", [randomUUID(), JSON.stringify(manifest), JSON.stringify({ status: 'error', lastError: `[CAGE-WORKER-001] ${marker}`, payload: { secret: marker } })]);
  const result = await http(owner, '/api/sys/diagnostics');
  expect(result.statusCode).toBe(200);
  expect(result.body).not.toContain(marker);
  expect(result.json().worker.details.lastError).toMatchObject({ code: 'CAGE-WORKER-001' });
  expect(result.json().worker.details).not.toHaveProperty('payload');
});

it('单连接池可完成多个导出；生成审计故障不留下文件并支持重投', async () => {
  const kernel = createKernel({ domain, urls: env.urls, poolSize: 1, logger: { ...silentLogger } });
  try {
    const ctx = await kernel.contextFor(ops.id, env.tenantId);
    const tasks = [
      await kernel.transfers.export('DiagnosticRecord', {}, ctx!, randomUUID()),
      await kernel.transfers.export('DiagnosticRecord', {}, ctx!, randomUUID()),
    ];
    // 本文件之前创建的记录事件为显式记录事件，先完成它们，再只投递导出任务。
    await env.query("update sys.outbox set status='done' where event <> 'cage:DataTransferRequested'");
    const worker = createWorker(kernel, { concurrency: 2, jobs: false });
    await worker.drain(1);
    for (const task of tasks) expect((await kernel.transfers.get(task.id, ctx!)).status).toBe('completed');
    const attempt = await kernel.transfers.export('DiagnosticRecord', {}, ctx!, randomUUID());
    const original = kernel.writeAudit.bind(kernel);
    const spy = vi.spyOn(kernel, 'writeAudit').mockImplementation((db, entry) => entry.kind === 'read' && entry.capability === 'DiagnosticRecord.export' ? Promise.reject(new Error('synthetic export audit failure')) : original(db, entry));
    await worker.drain(1);
    const [failed] = await env.query('select status,file_body,outbox_id from sys.data_transfer where id=$1', [attempt.id]);
    expect(failed).toMatchObject({ status: 'queued', file_body: null });
    expect(await env.query('select * from sys.processed_event where event_id=$1', [failed.outbox_id])).toEqual([]);
    await expect(kernel.transfers.download(attempt.id, ctx!)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    spy.mockRestore();
    await env.query('update sys.outbox set next_at=now() where id=$1', [failed.outbox_id]);
    await worker.drain(1);
    expect((await kernel.transfers.get(attempt.id, ctx!)).status).toBe('completed');
    const auditDownload = vi.spyOn(kernel, 'writeAudit').mockRejectedValue(new Error('synthetic download audit failure'));
    const auditLog = vi.spyOn(kernel.log, 'error');
    const requestId = 'diagnostic-download-audit-failure';
    await expect(kernel.transfers.download(attempt.id, { ...ctx!, requestId })).rejects.toMatchObject({ code: 'INTERNAL', detail: { diagnostic: 'CAGE-AUDIT-001', phase: 'audit', operation: 'dataTransfer.download', retryable: true } });
    expect(auditLog).toHaveBeenCalledExactlyOnceWith({ code: 'CAGE-AUDIT-001', operation: 'dataTransfer.download', task: attempt.id, requestId }, '下载审计失败，未交付文件');
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('synthetic download audit failure');
    auditDownload.mockRestore();
    expect((await kernel.transfers.download(attempt.id, ctx!)).body).toContain('13812345678');
  } finally { await kernel.close(); }
});

it('敏感字段按safe投影排序，掩码相同按id稳定排序，明文排序在交付前可靠审计', async () => {
  const rows = [
    { id: '00000000-0000-4000-8000-000000000003', phone: '13899990000' },
    { id: '00000000-0000-4000-8000-000000000002', phone: '13800001111' },
    { id: '00000000-0000-4000-8000-000000000001', phone: '13811110000' },
  ];
  for (const row of rows) await env.kernel.execute('DiagnosticRecord.create', { ...row, label: 'phonesort' }, await owner.ctx());
  const maskedCtx = { ...await owner.ctx(), requestId: 'diagnostic-sort-masked' };
  const masked = await env.kernel.read.list(DiagnosticRecord, { label: 'phonesort', sort: 'phone' }, maskedCtx);
  expect(masked.items.map((row) => row.id)).toEqual([rows[2].id, rows[0].id, rows[1].id]);
  expect(masked.items.map((row) => row.phone)).toEqual(['138****0000', '138****0000', '138****1111']);
  expect(await env.query("select id from sys.audit_log where request_id=$1 and kind='read'", [maskedCtx.requestId])).toEqual([]);
  const rawCtx = { ...await ops.ctx(), requestId: 'diagnostic-sort-raw' };
  const raw = await env.kernel.read.list(DiagnosticRecord, { label: 'phonesort', sort: 'phone' }, rawCtx);
  expect(raw.items.map((row) => row.id)).toEqual([rows[1].id, rows[2].id, rows[0].id]);
  const [audit] = await env.query("select diff from sys.audit_log where request_id=$1 and capability='DiagnosticRecord.read'", [rawCtx.requestId]);
  expect(audit.diff).toMatchObject({ unmasked: ['phone'], rows: 3 });
  vi.spyOn(env.kernel, 'writeAudit').mockRejectedValue(new Error('synthetic audit unavailable'));
  await expect(env.kernel.read.list(DiagnosticRecord, { label: 'phonesort', sort: 'phone' }, rawCtx)).rejects.toMatchObject({ code: 'INTERNAL', detail: { diagnostic: 'CAGE-AUDIT-001' } });
});
