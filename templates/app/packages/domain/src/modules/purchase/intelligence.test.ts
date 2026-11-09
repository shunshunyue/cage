/**
 * 以实际采购声明、应用迁移、真实 PostgreSQL 和 worker 回归 AI 预审到人工 OA 的完整业务链。
 * 只把模型生成器换为固定工具裁决，采购路由、协作名录、结论命令及库存反应仍使用应用实现。
 * 断言任务等待、会签完成和最终库存占用的区别；不连接应用数据库，也不把测试成功当作浏览器验收。
 */
import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ai, type ModelResult } from '@yss123/cage-ai';
import { readMigrations } from '@yss123/cage-kernel/db';
import { createTestEnv, type TestEnv, type TestUser } from '@yss123/cage-testkit';
import * as purchase from '../../index.js';

/** 每个场景显式设置固定裁决，测试运行时状态流转，不把真实模型的随机判断当作稳定断言。 */
let decision: 'pass' | 'return' | 'manual' = 'return';
/** 保留真实工具调用协议，只替换模型生成器；领域声明、审批引擎、数据库和 worker 仍使用实际实现。 */
const intelligence = ai({ models: { main: { spec: { kind: 'test-only' }, generate: async (): Promise<ModelResult> => ({ text: '', calls: [{ id: randomUUID(), name: 'review_decide',
  arguments: { decision, reason: '按当前用途审查', suggestions: decision === 'return' ? ['补充具体使用场景'] : [], evidence: [{ source: 'subject', detail: 'reason 字段' }] } }] }) } } });
let env: TestEnv, buyer: TestUser, reviewer: TestUser, specialistA: TestUser, specialistB: TestUser, financeA: TestUser, financeB: TestUser;
/**
 * 显式建立人工负责人和自动审查角色，证明声明本身不授予 AI 执行权限。
 * 自动角色只获 read/returnForChanges，不授 approve；通过 AI 节点后必须继续走人工经理结论。
 */
beforeAll(async () => {
  env = await createTestEnv({ domain: { ...purchase, intelligence }, migrations: readMigrations(fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url))) });
  buyer = await env.user({ caps: ['PurchaseOrder.read', 'PurchaseOrder.create', 'PurchaseOrder.explainPurpose', 'PurchaseOrder.submit', 'PurchaseOrder.setReviewers', 'ApprovalMember.read'],
    scopes: { ApprovalMember: 'all' } });
  reviewer = await env.user({ caps: ['PurchaseOrder.read', 'PurchaseOrder.approve', 'PurchaseOrder.returnForChanges'], scopes: { PurchaseOrder: 'dept' }, params: { 'PurchaseOrder.approve': { ceiling: 50000 } } });
  await env.kernel.execute('Dept.update', { id: env.rootDeptId, leaderId: reviewer.id }, env.system());
  await env.kernel.execute('Inventory.create', { sku: 'AI-01', available: 100 }, env.system());
  const role = await env.kernel.execute('Role.create', { code: 'purchase_ai_reviewer', name: '材料预审角色' }, env.system());
  for (const capability of ['PurchaseOrder.read', 'PurchaseOrder.returnForChanges']) await env.kernel.execute('Role.grantCapability', { id: role.id, capability }, env.system());
  await env.kernel.execute('Role.setScope', { id: role.id, aggregate: 'PurchaseOrder', combinator: 'all' }, env.system());
  specialistA = await collaborator('设备技术复核'); specialistB = await collaborator('采购合规复核');
  financeA = await collaborator('财务共享受理甲'); financeB = await collaborator('财务共享受理乙');
  const financeRole = await env.kernel.execute('Role.create', { code: 'finance', name: '采购财务候选人员' }, env.system());
  for (const user of [financeA, financeB]) await env.kernel.execute('User.assignRoles', { id: user.id, roleIds: [user.roleId, financeRole.id] }, env.system());
});
afterAll(() => env?.close());

/**
 * 通过组织和业务命令登记同部门协作人；10 万元额度只供本隔离库验证大额流程，名录本身不授予能力。
 * 专业和财务共享这些真实审批能力，财务候选身份由额外的 finance 角色单独赋予。
 */
async function collaborator(specialty: string) {
  const user = await env.user({ caps: ['PurchaseOrder.read', 'PurchaseOrder.approve', 'PurchaseOrder.reject', 'PurchaseOrder.returnForChanges'],
    scopes: { PurchaseOrder: 'dept' }, params: { 'PurchaseOrder.approve': { ceiling: 100000 } } });
  await env.kernel.execute('ApprovalMember.create', { userId: user.id, displayName: specialty, specialty }, env.system());
  return user;
}

/** 创建固定物料草稿；金额按元传输，专业名单仍交真实 create/submit 命令校验。 */
async function draft(options: { amount?: string; needsSpecialistReview?: boolean; reviewerIds?: string[] } = {}) {
  return env.kernel.execute('PurchaseOrder.create', { amount: '1200.00', reason: '用途待补充', items: [{ sku: 'AI-01', qty: 2 }], ...options }, await buyer.ctx());
}

/** 提交真实采购单并消费当前事件；固定模型输出使每例从明确 AI 结果开始，不替换人工审批路由。 */
async function submit(options: { amount?: string; needsSpecialistReview?: boolean; reviewerIds?: string[] } = {}) {
  const order = await draft(options);
  await env.kernel.execute('PurchaseOrder.submit', { id: order.id }, await buyer.ctx()); await env.drain(); return order;
}

/** 从操作者本人待办重新取得当前 revision，避免复用动作发生前的旧页面版本。 */
async function taskOf(user: TestUser, orderId: string, status = 'pending') {
  const task = (await purchase.poRoute.engine(env.kernel).tasksOf(user.id, env.tenantId, status)).find(item => item.businessKey === orderId);
  expect(task).toBeDefined(); return task!;
}

/** 通过真实待办批准当前节点，最终节点才会执行采购领域命令和同事务库存占用。 */
async function approveBy(user: TestUser, orderId: string) {
  const task = await taskOf(user, orderId);
  await purchase.poRoute.engine(env.kernel).decide(task.id, user.id, env.tenantId, 'approved', undefined, task.revision);
}

/** 以采购员安全读侧核对业务状态，不从任务通过的局部结果推断整张单据已经批准。 */
async function orderStatus(orderId: string) { return (await env.kernel.read.get(purchase.PurchaseOrder, orderId, await buyer.ctx())).status; }
/** 退回不覆盖旧审批证据；重新提交产生新轮次，历史保留上次建议且最新轮次继续经理待办。 */
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
/** 区分节点 pass 与业务 approved；只有最终人工结论落地才执行批准命令和同事务占用。 */
it('AI 通过只推进到经理节点，经理通过后才执行批准命令及库存锁', async () => {
  decision = 'pass'; const order = await submit(), engine = purchase.poRoute.engine(env.kernel);
  expect((await env.kernel.read.get(purchase.PurchaseOrder, order.id, await buyer.ctx())).status).toBe('pending_approval');
  const task = (await engine.tasksOf(reviewer.id, env.tenantId)).find(t => t.businessKey === order.id)!;
  await engine.decide(task.id, reviewer.id, env.tenantId, 'approved', undefined, task.revision);
  expect((await env.kernel.read.get(purchase.PurchaseOrder, order.id, await buyer.ctx())).status).toBe('approved');
  expect((await env.query('select status from core.inventory_lock where id = $1', [order.id]))[0].status).toBe('held');
});
/** manual 不越过 AI 节点，接管人处理当前节点并可通过领域命令退回草稿。 */
it('AI 转人工保留在本节点，人工可退回修改', async () => {
  decision = 'manual'; const order = await submit(), engine = purchase.poRoute.engine(env.kernel);
  const task = (await engine.tasksOf(reviewer.id, env.tenantId)).find(t => t.businessKey === order.id)!; expect(task.step).toBe(0);
  await engine.decide(task.id, reviewer.id, env.tenantId, 'returned', '请补充审批材料');
  expect((await env.kernel.read.get(purchase.PurchaseOrder, order.id, await buyer.ctx())).status).toBe('draft');
});

/** 草稿允许暂存，但编辑和提交都拒绝不完整、自审、重复或未登记名单，失败不产生审批实例。 */
it.each(['无人', '重复', '本人', '未登记', '关闭仍有名单'] as const)('专业复核名单%s时，设置和提交均拒绝且保留草稿', async boundary => {
  const reviewerIds = boundary === '无人' ? [] : boundary === '重复' ? [specialistA.id, specialistA.id]
    : boundary === '本人' ? [buyer.id] : boundary === '未登记' ? [randomUUID()] : [specialistA.id];
  const needsSpecialistReview = boundary !== '关闭仍有名单';
  const domainCode = { 无人: 'REVIEWERS_REQUIRED', 重复: 'DUPLICATE_REVIEWERS', 本人: 'REVIEWER_IS_APPLICANT', 未登记: 'REVIEWER_UNAVAILABLE', 关闭仍有名单: 'REVIEWERS_NOT_REQUIRED' }[boundary];
  const order = await draft({ needsSpecialistReview, reviewerIds });
  expect(await env.callAs(await buyer.ctx(), 'PurchaseOrder.setReviewers', { id: order.id, needsSpecialistReview, reviewerIds })).toMatchObject({ ok: false, domainCode });
  expect(await env.callAs(await buyer.ctx(), 'PurchaseOrder.submit', { id: order.id })).toMatchObject({ ok: false, domainCode });
  expect(await orderStatus(order.id)).toBe('draft');
  expect(await env.query('select id from flow.approval_instance where business_key=$1', [order.id])).toHaveLength(0);
});

/** 名录通过业务 read 开放，用户无需 User.read；提交会重查设置后退役的成员，防止旧草稿带入新流程。 */
it('采购员无需系统用户读权限即可配置协作人，但提交拒绝已退役名单', async () => {
  const person = await env.user({ caps: [] });
  const member = await env.kernel.execute('ApprovalMember.create', { userId: person.id, displayName: '临时合同复核', specialty: '合同条款' }, env.system());
  expect((await env.kernel.read.get(purchase.ApprovalMember, member.id, await buyer.ctx())).displayName).toBe('临时合同复核');
  const order = await draft();
  await env.kernel.execute('PurchaseOrder.setReviewers', { id: order.id, needsSpecialistReview: true, reviewerIds: [person.id] }, await buyer.ctx());
  await env.kernel.execute('ApprovalMember.retire', { id: member.id }, env.system());
  expect(await env.callAs(await buyer.ctx(), 'PurchaseOrder.submit', { id: order.id })).toMatchObject({ ok: false, domainCode: 'REVIEWER_UNAVAILABLE' });
  expect(await orderStatus(order.id)).toBe('draft');
});

/** 两位字段选人均须完成；第一票不能提前触发批准命令和库存锁，最终签署者仍走真实领域约束。 */
it('经理后开启所选专业人员 all 会签，全部通过才批准并锁库存', async () => {
  decision = 'pass'; const order = await submit({ needsSpecialistReview: true, reviewerIds: [specialistA.id, specialistB.id] });
  await approveBy(reviewer, order.id);
  const a = await taskOf(specialistA, order.id), b = await taskOf(specialistB, order.id);
  expect(a.step).toBe(2); expect(b.step).toBe(2); expect(a.id).not.toBe(b.id);
  expect(a.actions).toEqual({ transfer: true, delegate: true, addSign: true });
  // 历史标题来自当前实例的步骤快照，帮助详情区分部门审核与专业会签；不读取或展示 AI 策略全文。
  const history = await purchase.poRoute.engine(env.kernel).history('PurchaseOrder', order.id, await buyer.ctx());
  expect(history[0].steps.map(step => step.title)).toEqual(['AI 材料预审', '部门经理审批', '专业人员会签']);
  await approveBy(specialistA, order.id);
  expect(await orderStatus(order.id)).toBe('pending_approval');
  expect(await env.query('select id from core.inventory_lock where id=$1', [order.id])).toHaveLength(0);
  await approveBy(specialistB, order.id);
  expect(await orderStatus(order.id)).toBe('approved');
  expect((await env.query('select status from core.inventory_lock where id=$1', [order.id]))[0].status).toBe('held');
});

/** gt 阈值必须保持严格大于；恰好 5 万元时经理的同额 ceiling 足够，不创建财务候选任务。 */
it('恰好 50000 元经理通过后直接批准，不产生财务候选待办', async () => {
  decision = 'pass'; const order = await submit({ amount: '50000.00' });
  await approveBy(reviewer, order.id);
  expect(await orderStatus(order.id)).toBe('approved');
  expect((await purchase.poRoute.engine(env.kernel).candidateTasks(financeA.id, env.tenantId)).some(task => task.businessKey === order.id)).toBe(false);
});

/** 同一大额采购仅建一个候选任务，领取/释放保留 revision，另一财务领取并批准后才产生库存锁。 */
it('超过 50000 元进入财务共享候选池，释放后另一人领取并完成真实采购审批', async () => {
  decision = 'pass'; const order = await submit({ amount: '50000.01' }), engine = purchase.poRoute.engine(env.kernel);
  await approveBy(reviewer, order.id);
  const a = (await engine.candidateTasks(financeA.id, env.tenantId)).find(task => task.businessKey === order.id)!;
  const b = (await engine.candidateTasks(financeB.id, env.tenantId)).find(task => task.businessKey === order.id)!;
  expect(a.id).toBe(b.id); expect(a.assignment).toBe('candidate'); expect(a.assigneeId).toBeNull();
  await expect(engine.decide(a.id, financeA.id, env.tenantId, 'approved', undefined, a.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await engine.act(a.id, financeA.id, env.tenantId, { action: 'claim', expectedRevision: a.revision, reason: '财务甲领取大额采购' });
  const claimed = await taskOf(financeA, order.id);
  await engine.act(a.id, financeA.id, env.tenantId, { action: 'unclaim', expectedRevision: claimed.revision, reason: '转回共享池由在岗财务受理' });
  await expect(engine.act(b.id, financeB.id, env.tenantId, { action: 'claim', expectedRevision: b.revision, reason: '旧列表尝试领取' })).rejects.toMatchObject({ code: 'CONFLICT' });
  const available = (await engine.candidateTasks(financeB.id, env.tenantId)).find(task => task.businessKey === order.id)!;
  await engine.act(available.id, financeB.id, env.tenantId, { action: 'claim', expectedRevision: available.revision, reason: '财务乙刷新后领取' });
  expect(await orderStatus(order.id)).toBe('pending_approval');
  await approveBy(financeB, order.id);
  expect(await orderStatus(order.id)).toBe('approved');
  expect((await env.query('select status from core.inventory_lock where id=$1', [order.id]))[0].status).toBe('held');
  const history = await engine.taskHistory('PurchaseOrder', order.id, await buyer.ctx(), { limit: 100 });
  expect(history.items.map(entry => entry.action)).toEqual(['approved', 'claim', 'unclaim', 'claim', 'approved']);
});

/** 转办在本例经理节点真实开放，原人不能用旧待办决定；最终采购命令使用接手人的身份。 */
it('经理将采购审核转办给协作人，由接手人完成批准并留下转办和决定记录', async () => {
  decision = 'pass'; const order = await submit(), engine = purchase.poRoute.engine(env.kernel), task = await taskOf(reviewer, order.id);
  await engine.act(task.id, reviewer.id, env.tenantId, { action: 'transfer', targetUserId: specialistA.id, expectedRevision: task.revision, reason: '设备细节交专业人员审核' });
  await expect(engine.decide(task.id, reviewer.id, env.tenantId, 'approved', undefined, task.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await approveBy(specialistA, order.id);
  expect(await orderStatus(order.id)).toBe('approved');
  const history = await engine.taskHistory('PurchaseOrder', order.id, await buyer.ctx());
  expect(history.items.map(entry => entry.action)).toEqual(['transfer', 'approved']);
  expect(await env.audit({ aggregateId: order.id, command: 'PurchaseOrder.approve', kind: 'write' })).toMatchObject([{ on_behalf_of: specialistA.id }]);
});

/** 委派用于协助核验，接手人只能完成归还；原经理作最终决定，避免把委派误作转办。 */
it('经理委派采购材料核查，协作人归还后仍由经理正式批准', async () => {
  decision = 'pass'; const order = await submit(), engine = purchase.poRoute.engine(env.kernel), task = await taskOf(reviewer, order.id);
  await engine.act(task.id, reviewer.id, env.tenantId, { action: 'delegate', targetUserId: specialistA.id, expectedRevision: task.revision, reason: '请核对设备技术材料' });
  const delegated = await taskOf(specialistA, order.id);
  expect(delegated).toMatchObject({ ownerId: reviewer.id, delegation: 'pending' });
  await expect(engine.decide(delegated.id, specialistA.id, env.tenantId, 'approved', undefined, delegated.revision)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  await engine.act(delegated.id, specialistA.id, env.tenantId, { action: 'resolve', expectedRevision: delegated.revision, reason: '已核对技术材料并归还' });
  expect(await orderStatus(order.id)).toBe('pending_approval');
  await approveBy(reviewer, order.id);
  expect(await orderStatus(order.id)).toBe('approved');
  const history = await engine.taskHistory('PurchaseOrder', order.id, await buyer.ctx());
  expect(history.items.map(entry => entry.action)).toEqual(['delegate', 'resolve', 'approved']);
});

/** 三种加签共用真实采购单：首票后都不能建锁，前/后置的等待状态必须按指定签序开放。 */
it.each(['before', 'parallel', 'after'] as const)('经理节点 %s 加签要求原审批与附加意见都完成才批准采购', async placement => {
  decision = 'pass'; const order = await submit(), engine = purchase.poRoute.engine(env.kernel), task = await taskOf(reviewer, order.id);
  await engine.act(task.id, reviewer.id, env.tenantId, { action: 'addSign', userIds: [specialistA.id], placement, expectedRevision: task.revision, reason: '采购设备补充专业意见' });
  if (placement === 'before') {
    expect((await taskOf(reviewer, order.id, 'waiting')).id).toBe(task.id);
    await approveBy(specialistA, order.id);
  } else {
    if (placement === 'after') {
      const waiting = await taskOf(specialistA, order.id, 'waiting');
      await expect(engine.decide(waiting.id, specialistA.id, env.tenantId, 'approved', undefined, waiting.revision)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    }
    await approveBy(reviewer, order.id);
  }
  expect(await orderStatus(order.id)).toBe('pending_approval');
  expect(await env.query('select id from core.inventory_lock where id=$1', [order.id])).toHaveLength(0);
  await approveBy(placement === 'before' ? reviewer : specialistA, order.id);
  expect(await orderStatus(order.id)).toBe('approved');
  expect((await env.query('select status from core.inventory_lock where id=$1', [order.id]))[0].status).toBe('held');
});
