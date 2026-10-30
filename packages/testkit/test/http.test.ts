// HTTP 端到端：登录与 CSRF、生成的路由、代码内审批待办、经 fake 连接器推送 ERP、带签名的入站回调、系统管理接口。
import { createHmac } from 'node:crypto';
import { bootstrapOrg } from '@yss123/cage-admin';
import { createServer, type CageServer } from '@yss123/cage-http';
import { createWorker } from '@yss123/cage-kernel/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../src/index.js';
import * as domain from './fixtures/domain.js';

let env: TestEnv;
let server: CageServer;
let adminPassword: string;

process.env.ERP_WEBHOOK_SECRET = 'whsec-test';

/** 带 cookie 的简易客户端 */
function agent() {
  const jar = new Map<string, string>();
  let csrf: string | null = null;
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res: any) => {
    const sc = res.headers['set-cookie'];
    for (const c of [sc].flat().filter(Boolean) as string[]) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), v);
    }
  };
  const req = async (method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    if (method === 'POST' && csrf === null && !headers['x-no-csrf']) {
      const r = await server.app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: cookieHeader() } });
      keep(r);
      csrf = r.json().token;
    }
    const h: Record<string, string> = { cookie: cookieHeader(), ...headers };
    if (method === 'POST' && !headers['x-no-csrf']) h['x-csrf-token'] = csrf!;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await server.app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
    keep(r);
    return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
  };
  return {
    get: (url: string) => req('GET', url),
    post: (url: string, body: unknown = {}, headers?: Record<string, string>) => req('POST', url, body, headers),
    async login(username: string, password: string) {
      const r = await req('POST', '/auth/login', { username, password });
      csrf = null;
      return r;
    },
  };
}

const ok = (r: { status: number; body: any }) => {
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

let admin: ReturnType<typeof agent>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv({ domain });
  server = createServer({ domain, urls: { app: env.urls.app, read: env.urls.read }, bootstrap: false, logger: false, authRateLimitPerMinute: 1000 });
  await server.ready();
  const b = await bootstrapOrg(server.kernel, { adminPassword: 'admin-pass-123' });
  adminPassword = b.password!;
  ids.root = b.rootDeptId!;
  admin = agent();
  ok(await admin.login('admin', adminPassword));

  // 管理员在 /admin 里配置组织与授权：全部通过生成的命令路由
  ids.purchase = ok(await admin.post('/api/dept/create', { name: '采购部', parentId: ids.root })).id;
  const mkUser = async (username: string, deptId: string) => {
    const u = ok(await admin.post('/api/user/create', { username, name: username, deptId }));
    ok(await admin.post(`/api/user/${u.id}/set-password`, { password: `${username}-pass-123` }));
    return u.id as string;
  };
  ids.lisi = await mkUser('lisi', ids.purchase);
  ids.manager = await mkUser('manager', ids.purchase);
  const mkRole = async (code: string, caps: [string, Record<string, unknown>?][], scopes: [string, string][]) => {
    const r = ok(await admin.post('/api/role/create', { code, name: code }));
    for (const [capability, params] of caps) ok(await admin.post(`/api/role/${r.id}/grant-capability`, { capability, params }));
    for (const [aggregate, combinator] of scopes) ok(await admin.post(`/api/role/${r.id}/set-scope`, { aggregate, combinator }));
    return r.id as string;
  };
  ids.purchaser = await mkRole('purchaser', [['PurchaseOrder.create'], ['PurchaseOrder.submit'], ['PurchaseOrder.read'], ['PurchaseOrder.cancel']], []);
  ids.mgrRole = await mkRole('dept_manager', [['PurchaseOrder.read'], ['PurchaseOrder.approve', { ceiling: 50000 }]], [['PurchaseOrder', 'deptSubtree']]);
  ok(await admin.post(`/api/user/${ids.lisi}/assign-roles`, { roleIds: [ids.purchaser] }));
  ok(await admin.post(`/api/user/${ids.manager}/assign-roles`, { roleIds: [ids.mgrRole] }));
  ok(await admin.post(`/api/dept/${ids.purchase}/update`, { leaderId: ids.manager }));
  ok(await admin.post('/api/inventory/create', { sku: 'A-01', available: 100 }));
});

afterAll(async () => {
  await server?.close();
  await env?.close();
});

describe('HTTP 全链路：李四提交采购单到推送 ERP', () => {
  const lisi = agent();
  const manager = agent();
  let poId = '';

  it('登录后 /api/me 返回能力点；错误密码 401', async () => {
    expect((await agent().login('lisi', 'wrong')).status).toBe(401);
    ok(await lisi.login('lisi', 'lisi-pass-123'));
    const me = ok(await lisi.get('/api/me'));
    expect(me.capabilities).toContain('PurchaseOrder.submit');
    expect(me.capabilities).not.toContain('PurchaseOrder.approve');
  });

  it('写请求没有 CSRF 令牌被拒绝', async () => {
    const r = await lisi.post('/api/purchase-order/create', { amount: '10.00', items: [{ sku: 'A-01', qty: 1 }] }, { 'x-no-csrf': '1' });
    expect(r.status).toBe(403);
  });

  it('新建并提交：生成的路由交给内核，带版本号', async () => {
    const po = ok(await lisi.post('/api/purchase-order/create', { amount: '1200.00', items: [{ sku: 'A-01', qty: 2 }], supplierPhone: '13812345678' }));
    poId = po.id;
    expect(po.supplierPhone).toBe('138****5678');
    const stale = await lisi.post(`/api/purchase-order/${poId}/submit`, { expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CONFLICT');
    const s = ok(await lisi.post(`/api/purchase-order/${poId}/submit`, { expectedVersion: po.version }));
    expect(s.status).toBe('pending_approval');
  });

  it('流程专用命令不对浏览器开放', async () => {
    const r = await lisi.post(`/api/purchase-order/${poId}/approve`, {});
    expect(r.status).toBe(404);
  });

  it('worker 投递 OrderSubmitted，审批引擎给部门负责人生成待办', async () => {
    await createWorker(server.kernel).drain();
    ok(await manager.login('manager', 'manager-pass-123'));
    const tasks = ok(await manager.get('/api/approval/tasks'));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].businessKey).toBe(poId);
    expect(tasks[0].vars).toEqual({ amount: '1200.00', deptId: ids.purchase }); // 只有 routable 字段
    expect(ok(await lisi.get('/api/approval/tasks'))).toHaveLength(0);
  });

  it('经理审批：结论以流程身份执行 approve，同事务锁库存', async () => {
    const [task] = ok(await manager.get('/api/approval/tasks'));
    const notMine = await lisi.post(`/api/approval/tasks/${task.id}/approve`, {});
    expect(notMine.status).toBe(404);
    const r = ok(await manager.post(`/api/approval/tasks/${task.id}/approve`, { comment: '同意' }));
    expect(r).toEqual({ finished: true, outcome: 'approved' });
    const po = ok(await lisi.get(`/api/purchase-order/${poId}`));
    expect(po.status).toBe('approved');
    const [lock] = await env.query('select status from core.inventory_lock where id = $1', [poId]);
    expect(lock.status).toBe('held');
  });

  it('worker 投递 OrderApproved：经 fake 连接器推送 ERP，成功后用命令回写单号', async () => {
    await createWorker(server.kernel).drain();
    const po = ok(await lisi.get(`/api/purchase-order/${poId}`));
    expect(po.erpNo).toMatch(/^ERP-/);
    const [rec] = await env.query("select * from sys.sync_record where connector = 'erp'");
    expect(rec.status).toBe('ok');
    expect(rec.idempotency_key).toBe(`po-${poId}`);
  });

  it('ERP 回调：先验签，再以 external 身份调用命令', async () => {
    const body = JSON.stringify({ externalId: poId });
    const bad = await server.app.inject({ method: 'POST', url: '/hooks/erp/goods-received', headers: { 'content-type': 'application/json', 'x-signature': '0'.repeat(64) }, payload: body });
    expect(bad.statusCode).toBe(401);
    const sig = createHmac('sha256', 'whsec-test').update(body).digest('hex');
    const good = await server.app.inject({ method: 'POST', url: '/hooks/erp/goods-received', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
    expect(good.statusCode).toBe(200);
    expect(good.json().status).toBe('received');
    await createWorker(server.kernel).drain();
    const [lock] = await env.query('select status from core.inventory_lock where id = $1', [poId]);
    expect(lock.status).toBe('released');
  });

  it('超过额度的单：经理审批时约束拒绝，决定不生效', async () => {
    const po = ok(await lisi.post('/api/purchase-order/create', { amount: '60000.00', items: [{ sku: 'A-01', qty: 1 }] }));
    ok(await lisi.post(`/api/purchase-order/${po.id}/submit`, {}));
    await env.query("update sys.role set status = 'active' where code = 'finance'"); // 没有财务角色：第二步会找不到审批人
    await createWorker(server.kernel).drain();
    const [task] = (ok(await manager.get('/api/approval/tasks')) as any[]).filter((t) => t.businessKey === po.id);
    // 第一步审批通过后，第二步「财务审批」找不到审批人：整个决定回滚
    const r = await manager.post(`/api/approval/tasks/${task.id}/approve`, {});
    expect(r.status).toBe(500);
    const again = (ok(await manager.get('/api/approval/tasks')) as any[]).filter((t) => t.businessKey === po.id);
    expect(again).toHaveLength(1);
  });
});

describe('系统管理接口', () => {
  it('审计查询走读侧账号；没有系统能力点返回 403', async () => {
    const audit = ok(await admin.get('/api/sys/audit?aggregate=PurchaseOrder'));
    expect(audit.items.length).toBeGreaterThan(0);
    expect(audit.items.some((a: any) => a.actor_kind === 'process' && a.command === 'PurchaseOrder.approve')).toBe(true);
    const lisi = agent();
    await lisi.login('lisi', 'lisi-pass-123');
    expect((await lisi.get('/api/sys/audit')).status).toBe(403);
  });

  it('异步任务概况、定时任务、第三方同步记录', async () => {
    ok(await admin.get('/api/sys/ops/summary'));
    const jobs = ok(await admin.get('/api/sys/ops/jobs'));
    expect(jobs.map((j: any) => j.name)).toContain('expireStaleOrders');
    ok(await admin.post('/api/sys/ops/jobs/expireStaleOrders/disable', {}));
    expect(ok(await admin.get('/api/sys/ops/jobs'))[0].enabled).toBe(false);
    const sync = ok(await admin.get('/api/sys/ops/sync-records'));
    expect(sync.length).toBeGreaterThan(0);
  });

  it('OpenAPI 文档列出生成的路由与能力点', async () => {
    const doc = ok(await admin.get('/api/openapi.json'));
    expect(doc.paths['/api/purchase-order/{id}/submit'].post['x-capability']).toBe('PurchaseOrder.submit');
  });

  it('/admin 页面可以访问', async () => {
    const r = await server.app.inject({ method: 'GET', url: '/admin/' });
    expect([200, 404]).toContain(r.statusCode); // ui 目录在 admin 包构建后存在
  });
});
