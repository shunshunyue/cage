// 模型决策用固定脚本，回归实际采购声明如何消费框架 AI 节点、命令和审批引擎。
import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ai, type ModelResult } from '@yss123/cage-ai';
import { readMigrations } from '@yss123/cage-kernel/db';
import { createTestEnv, type TestEnv, type TestUser } from '@yss123/cage-testkit';
import * as purchase from '../../index.js';

let decision: 'pass' | 'return' | 'manual' = 'return';
const intelligence = ai({ models: { main: { spec: { kind: 'test-only' }, generate: async (): Promise<ModelResult> => ({ text: '', calls: [{ id: randomUUID(), name: 'review_decide',
  arguments: { decision, reason: '按当前用途审查', suggestions: decision === 'return' ? ['补充具体使用场景'] : [], evidence: [{ source: 'subject', detail: 'reason 字段' }] } }] }) } } });
let env: TestEnv, buyer: TestUser, reviewer: TestUser;
beforeAll(async () => {
  env = await createTestEnv({ domain: { ...purchase, intelligence }, migrations: readMigrations(fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url))) });
  buyer = await env.user({ caps: ['PurchaseOrder.read', 'PurchaseOrder.create', 'PurchaseOrder.explainPurpose', 'PurchaseOrder.submit'] });
  reviewer = await env.user({ caps: ['PurchaseOrder.read', 'PurchaseOrder.approve', 'PurchaseOrder.returnForChanges'], scopes: { PurchaseOrder: 'dept' }, params: { 'PurchaseOrder.approve': { ceiling: 50000 } } });
  await env.kernel.execute('Dept.update', { id: env.rootDeptId, leaderId: reviewer.id }, env.system());
  await env.kernel.execute('Inventory.create', { sku: 'AI-01', available: 100 }, env.system());
  const role = await env.kernel.execute('Role.create', { code: 'purchase_ai_reviewer', name: '材料预审角色' }, env.system());
  for (const capability of ['PurchaseOrder.read', 'PurchaseOrder.returnForChanges']) await env.kernel.execute('Role.grantCapability', { id: role.id, capability }, env.system());
  await env.kernel.execute('Role.setScope', { id: role.id, aggregate: 'PurchaseOrder', combinator: 'all' }, env.system());
});
afterAll(() => env?.close());
async function submit() {
  const order = await env.kernel.execute('PurchaseOrder.create', { amount: '1200.00', reason: '用途待补充', items: [{ sku: 'AI-01', qty: 2 }] }, await buyer.ctx());
  await env.kernel.execute('PurchaseOrder.submit', { id: order.id }, await buyer.ctx()); await env.drain(); return order;
}
it('AI 退回修改后保存用途并重新提交，形成新轮次且先重新经过 AI 节点', async () => {
  decision = 'return'; const order = await submit();
  const returned = await env.kernel.read.get(purchase.PurchaseOrder, order.id, await buyer.ctx()); expect(returned.status).toBe('draft');
  await env.kernel.execute('PurchaseOrder.explainPurpose', { id: order.id, reason: '为研发同事配置办公键盘以满足新增人员的日常办公需要' }, await buyer.ctx());
  decision = 'pass'; await env.kernel.execute('PurchaseOrder.submit', { id: order.id }, await buyer.ctx()); await env.drain();
  const history = await purchase.poRoute.engine(env.kernel).history('PurchaseOrder', order.id, await buyer.ctx());
  expect(history).toHaveLength(2); expect(history[0].steps[0].decision?.decision).toBe('pass');
  expect(history[1].steps[0].decision?.suggestions).toEqual(['补充具体使用场景']);
  const tasks = await purchase.poRoute.engine(env.kernel).tasksOf(reviewer.id, env.tenantId); expect(tasks.find(t => t.businessKey === order.id)?.step).toBe(1);
});
it('AI 通过只推进到经理节点，经理通过后才执行批准命令及库存锁', async () => {
  decision = 'pass'; const order = await submit(), engine = purchase.poRoute.engine(env.kernel);
  expect((await env.kernel.read.get(purchase.PurchaseOrder, order.id, await buyer.ctx())).status).toBe('pending_approval');
  const task = (await engine.tasksOf(reviewer.id, env.tenantId)).find(t => t.businessKey === order.id)!;
  await engine.decide(task.id, reviewer.id, env.tenantId, 'approved');
  expect((await env.kernel.read.get(purchase.PurchaseOrder, order.id, await buyer.ctx())).status).toBe('approved');
  expect((await env.query('select status from core.inventory_lock where id = $1', [order.id]))[0].status).toBe('held');
});
it('AI 转人工保留在本节点，人工可退回修改', async () => {
  decision = 'manual'; const order = await submit(), engine = purchase.poRoute.engine(env.kernel);
  const task = (await engine.tasksOf(reviewer.id, env.tenantId)).find(t => t.businessKey === order.id)!; expect(task.step).toBe(0);
  await engine.decide(task.id, reviewer.id, env.tenantId, 'returned', '请补充审批材料');
  expect((await env.kernel.read.get(purchase.PurchaseOrder, order.id, await buyer.ctx())).status).toBe('draft');
});
