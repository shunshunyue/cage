// 定向业务测试补足通用造数无法准备的库存、审批人和角色参数。
// 使用真实 PostgreSQL 及示例迁移，确保示例不是仅能通过抽取的静态声明。
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestEnv, type TestEnv, type TestUser } from '@yss123/cage-testkit';
import { readMigrations } from '@yss123/cage-kernel/db';
import { systemCtx } from '@yss123/cage-kernel';
import { fileURLToPath } from 'node:url';
import * as domain from './index.js';

let env: TestEnv;
let buyer: TestUser;
let manager: TestUser;
beforeAll(async () => {
  env = await createTestEnv({
    domain,
    migrations: readMigrations(fileURLToPath(new URL('../../../db/migrations/', import.meta.url))),
  });
  buyer = await env.user({
    caps: ['PurchaseOrder.create', 'PurchaseOrder.submit', 'PurchaseOrder.cancel', 'PurchaseOrder.read'],
  });
  manager = await env.user({
    caps: ['PurchaseOrder.approve'],
    params: { 'PurchaseOrder.approve': { ceiling: 50000 } },
  });
  await env.kernel.execute('Dept.update', { id: env.rootDeptId, leaderId: manager.id }, env.system());
  await env.kernel.execute('Inventory.create', { sku: 'A-01', available: 100 }, env.system());
});
afterAll(() => env?.close());

async function submitted() {
  const ctx = await buyer.ctx();
  const order = await env.kernel.execute(
    'PurchaseOrder.create',
    { amount: '1200.00', items: [{ sku: 'A-01', qty: 2 }] },
    ctx,
  );
  return env.kernel.execute('PurchaseOrder.submit', { id: order.id }, ctx);
}

it('审批成功同事务建锁；取消后 worker 释放锁，且每步都有审计', async () => {
  const order = await submitted();
  const process = env.kernel.processCtx({
    process: 'po-approval',
    tenantId: env.tenantId,
    onBehalfOf: manager.id,
    capabilities: ['PurchaseOrder.approve'],
  });
  await env.kernel.execute('PurchaseOrder.approve', { id: order.id }, process);
  expect(
    (await env.query('select status from core.inventory_lock where id = $1', [order.id]))[0].status,
  ).toBe('held');
  // 先完成审批事件及 ERP 回写，再验证后续取消的资源释放。
  // 同一单据的 outbox 严格按顺序执行，不能越过尚未成功的前序事件。
  await env.drain();
  await env.kernel.execute('PurchaseOrder.cancel', { id: order.id }, await buyer.ctx());
  await env.drain();
  expect(
    (await env.query('select status from core.inventory_lock where id = $1', [order.id]))[0].status,
  ).toBe('released');
  expect(
    await env.audit({ aggregateId: order.id, command: 'PurchaseOrder.approve', kind: 'write' }),
  ).toHaveLength(1);
});

it('提单人不能借流程身份审批自己的采购单', async () => {
  const order = await submitted();
  const process = env.kernel.processCtx({
    process: 'po-approval',
    tenantId: env.tenantId,
    onBehalfOf: buyer.id,
    capabilities: ['PurchaseOrder.approve'],
  });
  expect((await env.callAs(process, 'PurchaseOrder.approve', { id: order.id })).code).toBe(
    'CONSTRAINT_VIOLATED',
  );
});

it.each(['cancelled', 'received'] as const)(
  '采购单进入 %s 后，延迟的 ERP 回写保留终态且不会阻塞解锁',
  async (status) => {
    const order = await submitted();
    const process = env.kernel.processCtx({
      process: 'po-approval',
      tenantId: env.tenantId,
      onBehalfOf: manager.id,
      capabilities: ['PurchaseOrder.approve'],
    });
    await env.kernel.execute('PurchaseOrder.approve', { id: order.id }, process);
    // 有意在处理 outbox 之前取消：数据库命令与第三方响应之间没有完成顺序保证。
    // 断言最终业务状态和资源状态，避免仅验证命令返回成功而漏掉死信阻塞。
    if (status === 'cancelled') {
      await env.kernel.execute('PurchaseOrder.cancel', { id: order.id }, await buyer.ctx());
    } else {
      const external = systemCtx({
        kind: 'external',
        name: 'erp',
        tenantId: env.tenantId,
        capabilities: ['PurchaseOrder.markReceived'],
      });
      await env.kernel.execute('PurchaseOrder.markReceived', { id: order.id }, external);
    }
    await env.drain();
    const saved = (
      await env.query('select status, erp_no, version from core.purchase_order where id = $1', [order.id])
    )[0];
    expect(saved.status).toBe(status);
    expect(saved.erp_no).toBeTruthy();
    expect(saved.version).toBe(5);
    expect(
      (await env.query('select status from core.inventory_lock where id = $1', [order.id]))[0].status,
    ).toBe('released');
    expect(
      await env.query('select id from sys.dead_letter where aggregate_id = $1', [order.id]),
    ).toHaveLength(0);
    expect(
      await env.audit({ aggregateId: order.id, command: 'PurchaseOrder.recordErpNo', kind: 'write' }),
    ).toHaveLength(1);
  },
);

it('审批额度不够时保留待审批状态，不创建库存锁', async () => {
  const order = await submitted();
  const lowLimit = await env.user({
    caps: ['PurchaseOrder.approve'],
    params: { 'PurchaseOrder.approve': { ceiling: 500 } },
  });
  const process = env.kernel.processCtx({
    process: 'po-approval',
    tenantId: env.tenantId,
    onBehalfOf: lowLimit.id,
    capabilities: ['PurchaseOrder.approve'],
  });
  expect((await env.callAs(process, 'PurchaseOrder.approve', { id: order.id })).code).toBe(
    'CONSTRAINT_VIOLATED',
  );
  expect(await env.query('select id from core.inventory_lock where id = $1', [order.id])).toHaveLength(0);
});
