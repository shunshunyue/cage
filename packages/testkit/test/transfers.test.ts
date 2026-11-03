// 只覆盖任务边界新增的风险：权限快照、文件解析、同事务重投和真实 PostgreSQL 保存点。
// 命令的普通业务行为由现有 kernel/http 用例负责，不在这里重复穷举。
import { randomUUID } from 'node:crypto';
import { createServer, type CageServer } from '@yss123/cage-http';
import { createWorker, claimBatch, deliver } from '@yss123/cage-kernel/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { csvInputs, parseCsv } from '../../kernel/src/transfer/csv.js';
import { expireTransfers } from '../../kernel/src/transfer/index.js';
import { z } from 'zod';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';
import * as domain from './fixtures/domain.js';

let env: TestEnv, server: CageServer, owner: TestUser, other: TestUser, cookie: string;
beforeAll(async () => {
  env = await createTestEnv({ domain });
  owner = await env.user({ caps: ['PurchaseOrder.create', 'PurchaseOrder.cancel', 'PurchaseOrder.export', 'Inventory.create', 'Inventory.export'], scopes: { Inventory: 'all' } });
  other = await env.user({ caps: ['PurchaseOrder.export'] });
  await env.kernel.execute('User.setPassword', { id: owner.id, password: 'transfer-test-pass' }, env.system());
  // 通用接口不依赖系统管理 UI；业务前端关闭 admin 后仍可调用。
  server = createServer({ domain, urls: env.urls, admin: false, bootstrap: false, logger: false, csrf: false });
  await server.ready();
  const login = await server.app.inject({ method: 'POST', url: '/auth/login', payload: { username: owner.username, password: 'transfer-test-pass' } });
  expect(login.statusCode).toBe(200);
  cookie = [login.headers['set-cookie']].flat().filter(Boolean).map((v) => String(v).split(';')[0]).join('; ');
});
afterAll(async () => { await server?.close(); await env?.close(); });

const request = (url: string, payload: object, key = randomUUID()) => server.app.inject({ method: 'POST', url, payload, headers: { cookie, 'idempotency-key': key } });
const po = (amount = '20') => ({ amount, items: [{ sku: 'sample', qty: 1 }], supplierPhone: '13812345678' });

it('HTTP 先返回 202；worker 使用本人范围和掩码生成 CSV，任务及文件按提交人和租户隔离', async () => {
  const mine = await env.kernel.execute('PurchaseOrder.create', po(), await owner.ctx());
  const theirs = await env.insert('PurchaseOrder', { ...po(), ownerId: other.id });
  const response = await request('/api/purchase-order/export', {});
  expect(response.statusCode).toBe(202);
  const task = response.json();
  expect(task.status).toBe('queued');
  const ctx = await owner.ctx();
  await expect(env.kernel.transfers.download(task.id, ctx)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  await expect(env.kernel.transfers.get(task.id, await other.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(env.kernel.transfers.download(task.id, { ...ctx, tenantId: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await env.drain();
  const download = await server.app.inject({ method: 'GET', url: `/api/sys/transfers/${task.id}/download`, headers: { cookie } });
  expect(download.statusCode).toBe(200);
  expect(download.headers['cache-control']).toBe('no-store');
  expect(download.body).toContain(mine.id);
  expect(download.body).not.toContain(theirs.id);
  expect(download.body).toContain('138****5678');
  expect(download.body).not.toContain('13812345678');
  expect(await env.kernel.transfers.get(task.id, ctx)).toMatchObject({ status: 'completed', result: { rows: 1 } });
  expect((await server.app.inject({ method: 'GET', url: '/api/sys/transfers?aggregate=PurchaseOrder', headers: { cookie } })).json()).toHaveLength(1);
  expect((await server.app.inject({ method: 'GET', url: '/api/sys/transfers?aggregate=Inventory', headers: { cookie } })).json()).toEqual([]);
  const spec = (await server.app.inject('/api/openapi.json')).json();
  expect(spec.paths['/api/purchase-order/export'].post.responses['202']).toBeTruthy();
  expect((await server.app.inject('/admin/')).statusCode).toBe(404);
});

it('导出跨越原来的 10000 行限制，分页排序相同时仍不重不漏', async () => {
  await env.query("insert into core.inventory (id, tenant_id, sku, available, status, version) select gen_random_uuid(), $1, 'bulk-' || n, -701, 'active', 1 from generate_series(1,10001) as n", [env.tenantId]);
  const ctx = await owner.ctx();
  const task = await env.kernel.transfers.export('Inventory', { available: -701, page: 99, pageSize: 1 }, ctx, randomUUID());
  await env.drain();
  expect((await env.kernel.transfers.get(task.id, ctx)).result?.rows).toBe(10001);
  const lines = (await env.kernel.transfers.download(task.id, ctx)).body.split('\n');
  expect(lines).toHaveLength(10002);
  expect(new Set(lines.slice(1).map((line) => line.split(',')[0])).size).toBe(10001);
});

it('并发重复提交只创建一个任务，同键不同内容返回冲突', async () => {
  const key = randomUUID(), ctx = await owner.ctx();
  const tasks = await Promise.all([1, 2].map(() => env.kernel.transfers.export('Inventory', { available: 12 }, ctx, key)));
  expect(tasks[0].id).toBe(tasks[1].id);
  await expect(env.kernel.transfers.export('Inventory', { available: 13 }, ctx, key)).rejects.toMatchObject({ code: 'CONFLICT' });
  const count = await env.query('select count(*)::int as n from sys.outbox where aggregate_id = $1', [tasks[0].id]);
  expect(count[0].n).toBe(1);
  await env.drain();
});

it('排队后收回能力会拒绝执行；已生成文件在范围或明文权限变化后拒绝下载', async () => {
  const user = await env.user({ caps: ['PurchaseOrder.export'], scopes: { PurchaseOrder: 'all' } });
  const ctx = await user.ctx();
  const complete = await env.kernel.transfers.export('PurchaseOrder', {}, ctx, randomUUID());
  await env.drain();
  await env.kernel.execute('Role.grantCapability', { id: user.roleId, capability: 'PurchaseOrder.unmask.phone' }, env.system());
  await expect(env.kernel.transfers.download(complete.id, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const queued = await env.kernel.transfers.export('PurchaseOrder', {}, ctx, randomUUID());
  await env.kernel.execute('Role.revokeCapability', { id: user.roleId, capability: 'PurchaseOrder.export' }, env.system());
  await env.drain();
  expect(await env.kernel.transfers.get(queued.id, ctx)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' });
});

it('CSV 导入逐行走命令；约束失败不影响其他行，结果不回显敏感输入', async () => {
  const ctx = await owner.ctx();
  const csv = 'sku,available\r\n"part,one",2\r\n"part,one",3\r\npart-three,4';
  const response = await request('/api/sys/transfers/import', { command: 'Inventory.create', csv });
  expect(response.statusCode).toBe(202);
  const task = response.json();
  await env.drain();
  const report = JSON.parse((await env.kernel.transfers.download(task.id, ctx)).body);
  expect(report).toMatchObject({ succeeded: 2, failed: 1, atomic: false });
  expect(report.results).toEqual([{ row: 2, ok: true }, { row: 3, ok: false, code: 'CONFLICT' }, { row: 4, ok: true }]);
  expect(JSON.stringify(report)).not.toContain('part,one');
  expect((await env.query("select count(*)::int n from sys.audit_log where source='import' and command='Inventory.create'"))[0].n).toBe(2);
  expect((await env.query('select input from sys.data_transfer where id = $1', [task.id]))[0].input).toBeNull();
});

it('整批原子模式撤销全部业务记录和写审计，但保留失败报告', async () => {
  const ctx = await owner.ctx();
  const task = await env.kernel.transfers.import({ command: 'Inventory.create', csv: 'sku,available\natomic-one,1\natomic-bad,no-number', atomic: true }, ctx, randomUUID());
  await env.drain();
  const report = JSON.parse((await env.kernel.transfers.download(task.id, ctx)).body);
  expect(report).toMatchObject({ succeeded: 0, failed: 2 });
  expect(report.results).toEqual([{ row: 2, ok: false, code: 'ABORTED' }, { row: 3, ok: false, code: 'INVALID_INPUT', fields: ['available'] }]);
  expect(await env.query("select id from core.inventory where sku like 'atomic-%'")).toEqual([]);
});

it('导入不能越过行级范围，也不能调用流程专用命令', async () => {
  const ctx = await owner.ctx();
  await expect(env.kernel.transfers.import({ command: 'PurchaseOrder.approve', csv: 'id\n' + randomUUID() }, ctx, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const hidden = await env.insert('PurchaseOrder', { ...po(), ownerId: other.id });
  const task = await env.kernel.transfers.import({ command: 'PurchaseOrder.cancel', csv: `id\n${hidden.id}` }, ctx, randomUUID());
  await env.drain();
  expect(JSON.parse((await env.kernel.transfers.download(task.id, ctx)).body).results).toEqual([{ row: 2, ok: false, code: 'NOT_FOUND' }]);
  expect((await env.query('select status from core.purchase_order where id=$1', [hidden.id]))[0].status).toBe('draft');
});

it('消费事务提交前崩溃时整体回滚，重新投递和重复投递都不会重复导入', async () => {
  const ctx = await owner.ctx();
  const task = await env.kernel.transfers.import({ command: 'Inventory.create', csv: 'sku,available\ncrash-once,7' }, ctx, randomUUID());
  const worker = createWorker(env.kernel);
  const consumer = worker.consumers.find((c) => c.name === 'cage:data-transfer')!;
  const [event] = await claimBatch(env.kernel);
  expect(event.aggregate_id).toBe(task.id);
  expect(await deliver(env.kernel, event, [{ ...consumer, async handle(...args) { await consumer.handle(...args); throw new Error('simulate worker crash before commit'); } }])).toBe('retry');
  expect(await env.query("select id from core.inventory where sku='crash-once'")).toEqual([]);
  await env.query('update sys.outbox set next_at=now() where id=$1', [event.id]);
  await env.drain();
  // 模拟投递成功回执丢失；processed_event 与业务结果同事务，第二次直接跳过。
  await env.query("update sys.outbox set status='pending',next_at=now() where id=$1", [event.id]);
  await env.drain();
  expect((await env.query("select count(*)::int n from core.inventory where sku='crash-once'"))[0].n).toBe(1);
  expect((await env.kernel.transfers.get(task.id, ctx)).status).toBe('completed');
});

it('任务到期立即停止下载，维护任务清除文件内容；格式错误在入队前报告', async () => {
  const ctx = await owner.ctx();
  const task = await env.kernel.transfers.export('Inventory', { available: 7 }, ctx, randomUUID());
  await env.drain();
  await env.query("update sys.data_transfer set expires_at=now()-interval '1 second' where id=$1", [task.id]);
  await expect(env.kernel.transfers.download(task.id, ctx)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  await expireTransfers(env.kernel);
  expect((await env.query('select input,file_body,result,status from sys.data_transfer where id=$1', [task.id]))[0]).toEqual({ input: null, file_body: null, result: null, status: 'expired' });
  const response = await request('/api/sys/transfers/import', { command: 'Inventory.create', csv: 'sku,available\na,1,2' });
  expect(response.statusCode).toBe(400);
  expect(parseCsv('\uFEFFname,note\r\n"a,b","line1\nline2"\r\n')).toEqual([['name', 'note'], ['a,b', 'line1\nline2']]);
  expect(() => parseCsv('a,a\nx,y')).toThrow();
  expect(() => parseCsv('a\n"open')).toThrow();
  expect(() => csvInputs('__proto__\nx', z.object({ name: z.string() }))).toThrow();
});
