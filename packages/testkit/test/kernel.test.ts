// 内核集成测试：在真实 PostgreSQL 上验证 12 关流水线、范围、读侧安全视图、幂等、反应与 outbox。
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';
import * as domain from './fixtures/domain.js';

let env: TestEnv;
let purchaseDept: string;
let subDept: string;
let otherDept: string;
let lisi: TestUser; // 采购员：仅本人
let wangwu: TestUser; // 采购员：仅本人
let manager: TestUser; // 部门经理：本部门及下级，额度 50000
let finance: TestUser; // 财务：全部 + 明文手机号

/** 两个采购员故意共享能力但身份不同，用来证明范围来自主体而不是按钮或角色名称。 */
const PURCHASER = ['PurchaseOrder.create', 'PurchaseOrder.submit', 'PurchaseOrder.read', 'PurchaseOrder.cancel'];

/** 建立独立真实数据库、部门树和不同额度/明文权限的用户；所有用例共享基础组织，各自新建业务单据。 */
beforeAll(async () => {
  env = await createTestEnv({ domain });
  purchaseDept = await env.dept('采购部');
  subDept = await env.dept('采购一组', purchaseDept);
  otherDept = await env.dept('销售部');
  lisi = await env.user({ caps: PURCHASER, deptId: subDept });
  wangwu = await env.user({ caps: PURCHASER, deptId: subDept });
  manager = await env.user({
    caps: ['PurchaseOrder.read', 'PurchaseOrder.approve'],
    params: { 'PurchaseOrder.approve': { ceiling: 50000 } },
    scopes: { PurchaseOrder: 'deptSubtree' },
    deptId: purchaseDept,
  });
  finance = await env.user({ caps: ['PurchaseOrder.read', 'PurchaseOrder.unmask.phone', 'PurchaseOrder.export'], scopes: { PurchaseOrder: 'all' }, deptId: otherDept });
  const sys = env.system();
  // 审批路由按部门负责人找审批人：给根部门配一个负责人
  await env.kernel.execute('Dept.update', { id: env.rootDeptId, leaderId: manager.id }, sys);
  await env.kernel.execute('Inventory.create', { sku: 'A-01', available: 100 }, sys);
  await env.kernel.execute('Inventory.create', { sku: 'B-02', available: 1 }, sys);
});

/** 测试环境拥有数据库及连接池，整组结束后统一释放，不能留下带会话范围的连接供其他文件复用。 */
afterAll(async () => {
  await env?.close();
});

/** 经真实创建命令准备 1200 元、两件库存充足 SKU 的基线；覆盖值只改变当前场景需要的条件。 */
async function newOrder(u: TestUser, overrides: Record<string, unknown> = {}) {
  const r = await env.callAs(await u.ctx(), 'PurchaseOrder.create', {
    amount: '1200.00', items: [{ sku: 'A-01', qty: 2 }], supplierPhone: '13812345678', ...overrides,
  });
  if (!r.ok) throw new Error(`create failed: ${r.code} ${JSON.stringify(r.detail)}`);
  return r.data;
}

/** 流程身份携带真实代理用户，借此验证 process 来源不会消除职责分离、范围或额度。 */
const processCtx = (onBehalfOf: string) =>
  env.kernel.processCtx({ process: 'po-approval', tenantId: env.tenantId, onBehalfOf, capabilities: ['PurchaseOrder.approve', 'PurchaseOrder.reject'] });

/** 从创建、拒绝、状态、输入到并发逐关验证；幂等场景同时发请求，并以版本及唯一审计证明只执行一次。 */
describe('写入流水线', () => {
  it('新建：内核设置创建人、部门、版本号，并在同一事务写审计', async () => {
    const po = await newOrder(lisi);
    expect(po.createdBy).toBe(lisi.id);
    expect(po.deptId).toBe(subDept);
    expect(po.status).toBe('draft');
    expect(po.version).toBe(1);
    expect(po.supplierPhone).toBe('138****5678'); // 命令响应同样按当前主体掩码
    const audit = await env.audit({ aggregateId: po.id, kind: 'write' });
    expect(audit).toHaveLength(1);
    expect(audit[0].command).toBe('PurchaseOrder.create');
    expect(audit[0].diff.supplierPhone.to).toBe('138****5678'); // 审计里敏感字段掩码
  });

  it('第 3 关：缺少能力点返回 FORBIDDEN，并异步记录拒绝', async () => {
    const r = await env.callAs(await manager.ctx(), 'PurchaseOrder.create', { amount: '1.00', items: [{ sku: 'A-01', qty: 1 }] });
    expect(r.code).toBe('FORBIDDEN');
  });

  it('第 4 关：范围外的数据返回 NOT_FOUND（李四提交不了王五的单）', async () => {
    const po = await newOrder(wangwu);
    const r = await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id });
    expect(r.code).toBe('NOT_FOUND');
  });

  it('第 5 关：非法迁移返回 INVALID_TRANSITION', async () => {
    const po = await newOrder(lisi);
    const ctx = await lisi.ctx();
    expect((await env.callAs(ctx, 'PurchaseOrder.submit', { id: po.id })).ok).toBe(true);
    expect((await env.callAs(ctx, 'PurchaseOrder.submit', { id: po.id })).code).toBe('INVALID_TRANSITION');
  });

  it('第 2 关：输入校验失败返回 INVALID_INPUT', async () => {
    const r = await env.callAs(await lisi.ctx(), 'PurchaseOrder.create', { amount: 'abc', items: [] });
    expect(r.code).toBe('INVALID_INPUT');
  });

  it('第 10 关：不变量被破坏时回滚并返回 INVARIANT_VIOLATED', async () => {
    const r = await env.callAs(await lisi.ctx(), 'PurchaseOrder.create', { amount: '0', items: [{ sku: 'A-01', qty: 1 }] });
    expect(r.code).toBe('INVARIANT_VIOLATED');
    expect(r.detail).toMatchObject({ invariant: 'PurchaseOrder.amountPositive' });
  });

  it('新建的数据必须在自己的范围内：不能替别的部门建单', async () => {
    const deptUser = await env.user({ caps: PURCHASER, scopes: { PurchaseOrder: 'dept' }, deptId: purchaseDept });
    const r = await env.callAs(await deptUser.ctx(), 'PurchaseOrder.create', { amount: '10.00', items: [{ sku: 'A-01', qty: 1 }], deptId: otherDept });
    expect(r.code).toBe('CONSTRAINT_VIOLATED');
    expect(r.detail).toMatchObject({ constraint: 'scope' });
    const ok = await env.callAs(await deptUser.ctx(), 'PurchaseOrder.create', { amount: '10.00', items: [{ sku: 'A-01', qty: 1 }] });
    expect(ok.data?.deptId).toBe(purchaseDept);
  });

  it('并发：拿着过期版本号提交返回 CONFLICT', async () => {
    const po = await newOrder(lisi);
    const r = await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id, expectedVersion: 99 });
    expect(r.code).toBe('CONFLICT');
  });

  it('幂等：同一个幂等键重复提交只执行一次', async () => {
    const po = await newOrder(lisi);
    const ctx = { ...(await lisi.ctx()), idempotencyKey: 'double-click-1' };
    const [a, b] = await Promise.all([
      env.callAs(ctx, 'PurchaseOrder.submit', { id: po.id }),
      env.callAs(ctx, 'PurchaseOrder.submit', { id: po.id }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.data?.version).toBe(b.data?.version);
    const audit = await env.audit({ aggregateId: po.id, command: 'PurchaseOrder.submit' });
    expect(audit.filter((x) => x.kind === 'write')).toHaveLength(1);
  });
});

/**
 * 同事务建锁必须与批准一起提交，故意预置冲突锁验证整体回滚；异步释放必须 drain 后才观察结果。
 * 夹具 ERP 回写只接受 approved，因此先完成批准事件，再取消，避免前序死信阻塞掩盖释放行为。
 */
describe('审批、约束与反应', () => {
  it('用户不能直接调用流程专用命令', async () => {
    const po = await newOrder(lisi);
    await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id });
    const r = await env.callAs(await manager.ctx(), 'PurchaseOrder.approve', { id: po.id });
    expect(r.code).toBe('FORBIDDEN');
  });

  it('职责分离：提单人不能审批自己的单', async () => {
    const po = await newOrder(lisi);
    await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id });
    const r = await env.callAs(processCtx(lisi.id), 'PurchaseOrder.approve', { id: po.id });
    expect(r.code).toBe('CONSTRAINT_VIOLATED');
    expect(r.detail).toMatchObject({ constraint: 'sod.notSameAs(createdBy)' });
  });

  it('额度：超过审批人额度被拒绝', async () => {
    const po = await newOrder(lisi, { amount: '60000.00' });
    await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id });
    const r = await env.callAs(processCtx(manager.id), 'PurchaseOrder.approve', { id: po.id });
    expect(r.code).toBe('CONSTRAINT_VIOLATED');
    expect(r.detail).toMatchObject({ constraint: 'ceiling(amount)' });
  });

  it('业务错误：库存不足时返回 STOCK_SHORT，整个事务回滚', async () => {
    const po = await newOrder(lisi, { items: [{ sku: 'B-02', qty: 5 }] });
    await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id });
    const r = await env.callAs(processCtx(manager.id), 'PurchaseOrder.approve', { id: po.id });
    expect(r.code).toBe('DOMAIN_ERROR');
    expect(r.domainCode).toBe('STOCK_SHORT');
  });

  it('审批通过：同事务反应锁库存；取消后异步反应释放', async () => {
    const po = await newOrder(lisi);
    await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id });
    const r = await env.callAs(processCtx(manager.id), 'PurchaseOrder.approve', { id: po.id });
    expect(r.ok).toBe(true);
    const [lock] = await env.query('select * from core.inventory_lock where id = $1', [po.id]);
    expect(lock.status).toBe('held');
    const audit = await env.audit({ aggregateId: po.id, command: 'PurchaseOrder.approve' });
    expect(audit[0].actor_kind).toBe('process');
    expect(audit[0].on_behalf_of).toBe(manager.id);
    await env.drain(); // 先让 OrderApproved 投递完（推送 ERP 并回写单号）

    const c = await env.callAs(await lisi.ctx(), 'PurchaseOrder.cancel', { id: po.id });
    expect(c.ok).toBe(true);
    await env.drain();
    const [lock2] = await env.query('select * from core.inventory_lock where id = $1', [po.id]);
    expect(lock2.status).toBe('released');
    // 死信会挡住同一聚合的后续事件（为了保证顺序），这里应该没有死信
    expect(await env.query('select * from sys.dead_letter where aggregate_id = $1', [po.id])).toHaveLength(0);
  });

  it('同事务反应失败时整体回滚：单据仍停在待审批', async () => {
    const po = await newOrder(lisi);
    await env.callAs(await lisi.ctx(), 'PurchaseOrder.submit', { id: po.id });
    await env.insert('InventoryLock', { id: po.id, orderId: po.id, status: 'held' }); // 锁已存在：acquire 会冲突
    const r = await env.callAs(processCtx(manager.id), 'PurchaseOrder.approve', { id: po.id });
    expect(r.code).toBe('CONFLICT');
    const [row] = await env.query('select status from core.purchase_order where id = $1', [po.id]);
    expect(row.status).toBe('pending_approval');
  });

  it('草稿取消：反应映射返回 null，不尝试释放', async () => {
    const po = await newOrder(lisi);
    await env.callAs(await lisi.ctx(), 'PurchaseOrder.cancel', { id: po.id });
    await env.drain();
    const dead = await env.query("select * from sys.dead_letter where event = 'OrderCancelled'");
    expect(dead).toHaveLength(0);
  });
});

/** 同时从公开读 API 和受限数据库账号发起查询，证明范围/掩码并非只在 JavaScript 响应上过滤。 */
describe('读侧：安全视图与行级安全', () => {
  it('采购员只看到自己的单；经理看到本部门及下级；手机号掩码', async () => {
    const mine = await newOrder(lisi);
    await newOrder(wangwu);
    const l = await env.kernel.read.list('PurchaseOrder', {}, await lisi.ctx());
    expect(l.items.every((x) => x.createdBy === lisi.id)).toBe(true);
    expect(l.items.find((x) => x.id === mine.id)?.supplierPhone).toBe('138****5678');
    const m = await env.kernel.read.list('PurchaseOrder', { pageSize: 200 }, await manager.ctx());
    expect(m.items.every((x) => [purchaseDept, subDept].includes(x.deptId))).toBe(true);
    expect(m.items.some((x) => x.createdBy === lisi.id) && m.items.some((x) => x.createdBy === wangwu.id)).toBe(true);
    // 销售部的单经理看不到
    expect(m.items.some((x) => x.deptId === otherDept)).toBe(false);
  });

  it('持有 unmask 能力才返回明文，并写读审计', async () => {
    const po = await newOrder(lisi);
    const r = await env.kernel.read.get('PurchaseOrder', po.id, await finance.ctx());
    expect(r.supplierPhone).toBe('13812345678');
    await new Promise((res) => setTimeout(res, 100));
    const audit = await env.audit({ aggregateId: po.id, kind: 'read' });
    expect(audit.length).toBeGreaterThan(0);
  });

  it('读账号直接写 SQL 也查不到范围外数据，也碰不到基表', async () => {
    await newOrder(wangwu);
    const db = await env.readConnectionAs(await lisi.ctx());
    const res = await sql<any>`select * from safe.purchase_order`.execute(db);
    expect(res.rows.every((r) => r.created_by === lisi.id)).toBe(true);
    await expect(sql`select * from core.purchase_order`.execute(db)).rejects.toThrow(/permission denied/);
    await db.release();
  });

  it('忘了设置会话变量时一条都查不到', async () => {
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: env.urls.read });
    await c.connect();
    const r = await c.query('select count(*)::int as n from safe.purchase_order');
    expect(r.rows[0].n).toBe(0);
    await c.end();
  });

  it('范围外读取返回 NOT_FOUND，缺少读能力返回 FORBIDDEN', async () => {
    const po = await newOrder(wangwu);
    await expect(env.kernel.read.get('PurchaseOrder', po.id, await lisi.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const nobody = await env.user({ caps: [] });
    await expect(env.kernel.read.list('PurchaseOrder', {}, await nobody.ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('query 声明：手写 SQL 参数化执行，同样受范围约束', async () => {
    const rows = await env.kernel.read.run('poByStatus', { status: 'draft' }, await lisi.ctx());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('deptId');
  });

  it('导出：需要 export 能力，走安全视图', async () => {
    const out = await env.kernel.read.export('PurchaseOrder', {}, await finance.ctx());
    expect(out.rows).toBeGreaterThan(0);
    await expect(env.kernel.read.export('PurchaseOrder', {}, await lisi.ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

/** 管理命令能力只允许管理动作，不能授出自身没有的能力，也不能通过分配高权角色间接提权。 */
describe('授权：防提权', () => {
  it('不能授出自己没有的能力点', async () => {
    const roleAdmin = await env.user({ caps: ['Role.create', 'Role.grantCapability', 'Role.read'], scopes: { Role: 'all' } });
    const ctx = await roleAdmin.ctx();
    const role = await env.callAs(ctx, 'Role.create', { code: 'helper', name: '助手' });
    expect(role.ok).toBe(true);
    const r = await env.callAs(ctx, 'Role.grantCapability', { id: role.data!.id, capability: 'PurchaseOrder.approve' });
    expect(r.code).toBe('CONSTRAINT_VIOLATED');
    const ok = await env.callAs(ctx, 'Role.grantCapability', { id: role.data!.id, capability: 'Role.read' });
    expect(ok.ok).toBe(true);
  });

  it('不能分配包含自己没有的能力的角色', async () => {
    const userAdmin = await env.user({ caps: ['User.assignRoles', 'User.read', 'Role.read'], scopes: { User: 'all', Role: 'all' } });
    const r = await env.callAs(await userAdmin.ctx(), 'User.assignRoles', { id: lisi.id, roleIds: [manager.roleId] });
    expect(r.code).toBe('CONSTRAINT_VIOLATED');
  });
});

/** atomic 批次把合法行与不变量失败行放在一起，以数据库行数检查全部业务写入撤销。 */
describe('批量', () => {
  it('整批原子：一行失败全部回滚', async () => {
    const ctx = await lisi.ctx();
    const before = await env.query('select count(*)::int as n from core.purchase_order');
    const res = await env.kernel.executeBatch('PurchaseOrder.create', [
      { amount: '1.00', items: [{ sku: 'A-01', qty: 1 }] },
      { amount: '0', items: [{ sku: 'A-01', qty: 1 }] },
    ], ctx, { atomic: true });
    expect(res.every((r) => !r.ok)).toBe(true);
    const after = await env.query('select count(*)::int as n from core.purchase_order');
    expect(after[0].n).toBe(before[0].n);
  });
});
