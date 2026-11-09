/**
 * 原生 AND 并行审批的真实 PostgreSQL 验证：领域命令启动，独立分支办理，最终结论与业务共同提交。
 * 通用文件夹具不引用采购实现；覆盖跨分支先后、并发汇合、失败回滚、人员操作、SLA、AI 与旧快照。
 * 只有旧格式兼容用例通过测试管理员移除新快照元数据，其余成功路径不写流程状态、不伪造时间。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as org from '@yss123/cage-admin/domain';
import { aggregate, approval, ceiling, command, enumOf, event, id, money, ref, scope, states } from '@yss123/cage-kernel';
import { approver, approvalOperations, approvalOperationsService, branch, eq, InCodeEngine, parallel, route, step, when } from '@yss123/cage-approval';
import { ai, type ModelResult } from '@yss123/cage-ai';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

/** 金额采用元的十进制字符串；场景字段只选择声明分支，用户身份仍由内核填写。 */
const ParallelDocument = aggregate('ParallelDocument', {
  fields: { createdBy: ref('User'), amount: money(), scenario: enumOf('normal', 'final', 'nested', 'empty', 'ai', 'legacy') },
  states: states('draft', 'reviewing', 'accepted', 'rejected', 'cancelled', { terminal: ['accepted', 'rejected', 'cancelled'] }),
  scope: scope.self('createdBy'),
});
/** 提交和取消均经 outbox 触发审批，测试不直接调用 start 拼造业务轮次。 */
const Submitted = event('ParallelDocumentSubmitted', { id: id() });
const Cancelled = event('ParallelDocumentCancelled', { id: id() });
/** 创建/提交/取消是用户命令，结论仅允许流程身份；批准保留额度硬约束以检验回滚。 */
const create = command(ParallelDocument, { name: 'create', from: 'new', to: 'draft', input: z.object({
  amount: z.string(), scenario: z.enum(['normal', 'final', 'nested', 'empty', 'ai', 'legacy']),
}), handler: row => row });
const submit = command(ParallelDocument, { name: 'submit', from: 'draft', to: 'reviewing', emits: [Submitted], handler: row => row });
const cancel = command(ParallelDocument, { name: 'cancel', from: 'reviewing', to: 'cancelled', emits: [Cancelled], handler: row => row });
const accept = command(ParallelDocument, { name: 'accept', from: 'reviewing', to: 'accepted', invokedBy: 'process', constraints: [ceiling('amount')], handler: row => row });
const reject = command(ParallelDocument, { name: 'reject', from: 'reviewing', to: 'rejected', invokedBy: 'process', handler: row => row });
const revise = command(ParallelDocument, { name: 'revise', from: 'reviewing', to: 'draft', invokedBy: 'process', handler: row => row });
const review = approval(ParallelDocument, { process: 'parallel-document', start: Submitted, cancelOn: [Cancelled],
  routable: ['createdBy', 'scenario'], onApproved: accept, onRejected: reject, onReturned: revise, automatedBy: 'parallel_auto' });
/** 所有人工节点共享同一人员政策和六秒 SLA，时限由真实时钟驱动；催办冷却仍按实例共享。 */
const policy = { actions: { transfer: true, delegate: true, addSign: true }, sla: { durationMinutes: 0.1, remindBeforeMinutes: 0.09 } };
const human = (title: string, role: string) => step(title, approver.role(role), policy);
/** 常规路径包含两步财务分支和单步法务分支，汇合后总审；其他路径验证嵌套/空条件/末端汇合。 */
const reviewRoute = route('parallel-document', [
  when(eq('scenario', 'normal'), parallel('联合会审',
    branch('财务', step('财务初审', approver.role('parallel_finance'), { ...policy, assignment: 'candidate' }), human('财务复核', 'parallel_supervisor')),
    branch('法务', human('法务审核', 'parallel_legal'))), human('总审', 'parallel_chief')),
  when(eq('scenario', 'final'), parallel('末端会审', branch('财务', human('财务结论', 'parallel_finance')), branch('法务', human('法务结论', 'parallel_legal')))),
  when(eq('scenario', 'nested'), parallel('外层', branch('财务', parallel('内层',
    branch('初审', human('嵌套初审', 'parallel_finance')), branch('复核', human('嵌套复核', 'parallel_supervisor'))), human('财务汇总', 'parallel_chief')),
    branch('法务', human('外层法务', 'parallel_legal')))),
  when(eq('scenario', 'empty'), parallel('有条件会审', branch('财务', when(eq('scenario', 'never'), human('不应打开', 'parallel_finance'))),
    branch('法务', human('有效分支', 'parallel_legal'))), human('空分支汇总', 'parallel_chief')),
  when(eq('scenario', 'ai'), parallel('人机并行', branch('人工', human('人审', 'parallel_legal')), branch('智能', step('智能材料检查', {
    kind: 'ai', model: 'main', instructions: '核对当前申请，给出结论。', context: { fields: ['amount'] }, handoff: approver.role('parallel_finance'), onFailure: 'failed',
  }))), human('人机汇总', 'parallel_chief')),
  when(eq('scenario', 'legacy'), human('旧第一步', 'parallel_finance'), human('旧第二步', 'parallel_legal')),
], { reminders: { requesterField: 'createdBy', cooldownMinutes: 1 } });
const approvalOps = approvalOperations();
/** 模型仅作为协议驱动器；真实 AI 持久运行、授权和并行回执均由框架执行，不代表模型质量验收。 */
let modelReply: () => Promise<ModelResult> = async () => ({ text: '', calls: [{
  id: randomUUID(), name: 'review_decide', arguments: { decision: 'pass', reason: '材料齐全', evidence: [{ source: 'subject', detail: '当前金额有效' }], suggestions: [] },
}] });
const intelligence = ai({ models: { main: { spec: { kind: 'parallel-test' }, generate: () => modelReply() } } });
const domain = { ...org, ParallelDocument, Submitted, Cancelled, create, submit, cancel, accept, reject, revise, review, reviewRoute, approvalOps, intelligence };
let env: TestEnv, buyer: TestUser, finance: TestUser, legal: TestUser, supervisor: TestUser, chief: TestUser, extra: TestUser;
let engine: InCodeEngine, ops: ReturnType<typeof approvalOperationsService>;
const caps = ['ParallelDocument.read', 'ParallelDocument.accept', 'ParallelDocument.reject', 'ParallelDocument.revise'];

/** 每种职责一个独立账号，角色只用于选人，实际能力由各用户独立角色授权。 */
beforeAll(async () => {
  env = await createTestEnv({ domain }); engine = reviewRoute.engine(env.kernel); ops = approvalOperationsService(env.kernel);
  buyer = await env.user({ caps: ['ParallelDocument.read', 'ParallelDocument.create', 'ParallelDocument.submit', 'ParallelDocument.cancel'], scopes: { ParallelDocument: 'self' } });
  const member = async (code?: string, limit = 1000): Promise<TestUser> => {
    const user = await env.user({ caps, scopes: { ParallelDocument: 'all' }, params: { 'ParallelDocument.accept': { ceiling: limit } } });
    if (code) {
      const role = await env.kernel.execute('Role.create', { code, name: code }, env.system());
      await env.kernel.execute('User.assignRoles', { id: user.id, roleIds: [user.roleId, role.id] }, env.system());
    }
    return user;
  };
  finance = await member('parallel_finance'); legal = await member('parallel_legal'); supervisor = await member('parallel_supervisor');
  chief = await member('parallel_chief'); extra = await member(undefined, 10);
  const role = await env.kernel.execute('Role.create', { code: 'parallel_auto', name: '自动材料检查' }, env.system());
  for (const capability of caps) await env.kernel.execute('Role.grantCapability', { id: role.id, capability }, env.system());
  await env.kernel.execute('Role.setScope', { id: role.id, aggregate: 'ParallelDocument', combinator: 'all' }, env.system());
});
/** 关闭运行时后回收本文件独占的临时数据库，不能影响正在保留的浏览器演示环境。 */
afterAll(async () => { await intelligence.service(env.kernel).close(); await env?.close(); });

/** 从领域命令启动并排空 outbox；业务 id 作为所有后续断言的范围，防止跨用例待办干扰。 */
async function launch(scenario = 'normal', amount = '100.00') {
  const record = await env.kernel.execute('ParallelDocument.create', { scenario, amount }, await buyer.ctx());
  await env.kernel.execute('ParallelDocument.submit', { id: record.id }, await buyer.ctx()); await env.drain();
  return record.id as string;
}
/** 通过公开安全待办接口读取指定单据，不从数据库猜测当前办理人。 */
async function pending(user: TestUser, businessKey: string) { return (await engine.tasksOf(user.id, env.tenantId)).filter(task => task.businessKey === businessKey); }
/** 批准本人唯一待办，携带真实 revision；对分支完成与整轮完成分别断言。 */
async function approve(user: TestUser, businessKey: string, target = engine) {
  const task = (await pending(user, businessKey))[0]; expect(task).toBeDefined();
  return target.decide(task.id, user.id, env.tenantId, 'approved', '已核对当前材料', task.revision);
}
/** 候选财务先领取，体现候选待办与普通待办的真实区分。 */
async function claim(businessKey: string) {
  const task = (await engine.candidateTasks(finance.id, env.tenantId)).find(task => task.businessKey === businessKey)!;
  expect(task).toBeDefined(); await engine.act(task.id, finance.id, env.tenantId, { action: 'claim', expectedRevision: task.revision, reason: '负责财务审核' });
}
const history = async (businessKey: string) => (await engine.history('ParallelDocument', businessKey, await buyer.ctx()))[0];
const request = async (businessKey: string) => (await ops.requests(await buyer.ctx())).find(row => row.businessKey === businessKey)!;
const state = async (businessKey: string) => (await env.kernel.read.get(ParallelDocument, businessKey, await buyer.ctx())).status;

describe('结构化并行执行与事务边界', () => {
  it('多步分支独立推进，法务先完成也等待财务复核；汇合后只开一项总审', async () => {
    const id = await launch();
    expect((await history(id)).currentSteps).toEqual([0, 2]);
    expect((await pending(legal, id))[0].branchPath).toEqual([{ parallel: '联合会审', branch: '法务' }]);
    await approve(legal, id); expect(await pending(chief, id)).toHaveLength(0);
    await claim(id); await approve(finance, id);
    expect((await history(id)).currentSteps).toEqual([1]);
    expect(await pending(supervisor, id)).toHaveLength(1); expect(await pending(chief, id)).toHaveLength(0);
    await approve(supervisor, id); expect(await pending(chief, id)).toHaveLength(1);
    expect(await approve(chief, id)).toMatchObject({ finished: true, outcome: 'approved' });
    expect(await state(id)).toBe('accepted'); expect((await history(id)).currentSteps).toEqual([]);
  });
  it('两个实例持有者并发完成分支，汇合节点不会重复创建', async () => {
    const id = await launch(); await claim(id); await approve(finance, id);
    const other = new InCodeEngine(env.kernel, reviewRoute);
    await Promise.all([approve(legal, id), approve(supervisor, id, other)]);
    expect(await pending(chief, id)).toHaveLength(1);
    expect((await history(id)).steps.filter(row => row.title === '总审')).toHaveLength(1);
  });
  it('终端汇合的最后一票领域校验失败，票、节点与业务一起回滚', async () => {
    const id = await launch('final'); await approve(finance, id);
    const task = (await pending(legal, id))[0];
    await engine.act(task.id, legal.id, env.tenantId, { action: 'transfer', expectedRevision: task.revision, targetUserId: extra.id, reason: '测试当前额度' });
    await expect(approve(extra, id)).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATED' });
    expect(await state(id)).toBe('reviewing'); expect(await pending(extra, id)).toHaveLength(1);
    expect((await history(id)).steps.map(row => row.status)).toEqual(['approved', 'running']);
  });
  it.each(['rejected', 'returned'] as const)('%s 关闭其他活跃分支及未激活加签，历史已通过节点不覆盖', async outcome => {
    const id = await launch(); await claim(id);
    const task = (await pending(finance, id))[0];
    await engine.act(task.id, finance.id, env.tenantId, { action: 'addSign', expectedRevision: task.revision, userIds: [supervisor.id], placement: 'after', reason: '后签验证' });
    const other = (await pending(legal, id))[0];
    await engine.decide(other.id, legal.id, env.tenantId, outcome, '材料不符合要求', other.revision);
    expect(await pending(finance, id)).toHaveLength(0);
    expect((await engine.tasksOf(supervisor.id, env.tenantId, 'waiting')).filter(row => row.businessKey === id)).toHaveLength(0);
    expect((await history(id)).steps.map(row => row.status)).toEqual(['skipped', outcome]);
    expect(await state(id)).toBe(outcome === 'returned' ? 'draft' : 'rejected');
  });
  it('申请人取消关闭所有分支，迟到决定不能复活实例', async () => {
    const id = await launch(); const task = (await pending(legal, id))[0];
    await env.kernel.execute('ParallelDocument.cancel', { id }, await buyer.ctx()); await env.drain();
    expect((await history(id)).status).toBe('cancelled'); expect((await history(id)).currentSteps).toEqual([]);
    await expect(engine.decide(task.id, legal.id, env.tenantId, 'approved', '', task.revision)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
  it('嵌套汇合先完成内部集合，外层仍等待另一分支', async () => {
    const id = await launch('nested');
    expect((await history(id)).currentSteps).toEqual([0, 1, 3]);
    await approve(finance, id); expect(await pending(chief, id)).toHaveLength(0);
    await approve(supervisor, id); await approve(chief, id); expect(await state(id)).toBe('reviewing');
    expect(await approve(legal, id)).toMatchObject({ finished: true });
  });
  it('条件未命中的分支为空路径，不阻塞剩余分支汇合', async () => {
    const id = await launch('empty'); expect((await history(id)).currentSteps).toEqual([0]);
    await approve(legal, id); expect(await pending(chief, id)).toHaveLength(1); await approve(chief, id);
    expect(await pending(finance, id)).toHaveLength(0);
  });
  it('重建引擎和修改最新声明不会让在途实例换路线或版本', async () => {
    const id = await launch('final'), version = (await history(id)).definitionVersion;
    const replacement = new InCodeEngine(env.kernel, route('parallel-document', [human('发布后的新节点', 'parallel_chief')]));
    await approve(finance, id, replacement); await approve(legal, id, replacement);
    expect(await pending(chief, id)).toHaveLength(0); expect((await history(id)).definitionVersion).toBe(version);
    expect(version).toMatch(/^[0-9a-f]{64}$/);
  });
  it('并行分支中的后加签仍必签，不允许提前汇合', async () => {
    const id = await launch('final'), task = (await pending(legal, id))[0];
    await engine.act(task.id, legal.id, env.tenantId, { action: 'addSign', expectedRevision: 0, userIds: [chief.id], placement: 'after', reason: '责任复核' });
    await approve(finance, id); await approve(legal, id); expect(await state(id)).toBe('reviewing');
    expect(await pending(chief, id)).toHaveLength(1); await approve(chief, id); expect(await state(id)).toBe('accepted');
  });
  it('旧顺序快照不含执行元数据时仍按相邻步骤推进', async () => {
    const id = await launch('legacy');
    // 按历史实际格式构造兼容数据，不更改节点状态或权限；运行应完全取旧快照，不借最新路由补分支。
    await env.query(`update flow.approval_instance set steps = (select jsonb_agg(value - 'execution' order by ord)
      from jsonb_array_elements(steps) with ordinality as x(value,ord)) where business_key=$1`, [id]);
    expect((await history(id)).definitionVersion).toBeNull();
    await approve(finance, id); expect(await pending(legal, id)).toHaveLength(1); await approve(legal, id);
    expect(await state(id)).toBe('accepted');
  });
});

describe('并行提醒、授权和智能步骤', () => {
  it('催办覆盖所有分支，最小索引未变时也拒绝过期的完整节点集合', async () => {
    const id = await launch(), old = await request(id); await approve(legal, id);
    expect((await request(id)).currentStep).toBe(old.currentStep);
    await expect(ops.urge(old.id, await buyer.ctx(), { expectedStep: old.currentStep, expectedSteps: old.currentSteps, reason: '旧页面催办' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const fresh = await request(id);
    await expect(ops.urge(fresh.id, await buyer.ctx(), { expectedStep: fresh.currentStep, reason: '缺少集合' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await ops.urge(fresh.id, await buyer.ctx(), { expectedStep: fresh.currentStep, expectedSteps: fresh.currentSteps, reason: '请及时处理' })).toMatchObject({ recipientCount: 1 });
  });
  it('同一实例的两个节点独立计时和收件，非最小索引分支可标已读', async () => {
    const id = await launch('final'), current = await request(id);
    expect(await ops.urge(current.id, await buyer.ctx(), { expectedStep: current.currentStep, expectedSteps: current.currentSteps, reason: '各部门分别处理' })).toMatchObject({ recipientCount: 2 });
    const notices = (await ops.notices(await legal.ctx())).items.filter(row => row.businessKey === id);
    expect(notices).toHaveLength(1); await ops.readNotice(notices[0].id, await legal.ctx());
    // 等待真实临期时刻，未操作 due_at；仅定向查询当前单据避免其他运行实例影响断言。
    await new Promise(resolve => setTimeout(resolve, 650)); await ops.tick();
    expect((await ops.notices(await legal.ctx())).items.filter(row => row.businessKey === id && row.kind === 'due_soon')).toHaveLength(1);
    expect((await ops.notices(await finance.ctx())).items.filter(row => row.businessKey === id && row.kind === 'due_soon')).toHaveLength(1);
    await approve(legal, id); expect((await ops.notices(await legal.ctx())).items.filter(row => row.businessKey === id)).toHaveLength(0);
  });
  it('非最小索引分支仍核验本人归属，不能借并行放宽任务授权', async () => {
    const id = await launch('final'), task = (await pending(legal, id))[0];
    await expect(engine.decide(task.id, finance.id, env.tenantId, 'approved', '', task.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await pending(legal, id)).toHaveLength(1);
  });
  it('非最小索引 AI 节点可真实运行并等待人工分支汇合', async () => {
    const id = await launch('ai'); await intelligence.service(env.kernel).tick();
    const current = await history(id);
    expect(current.steps.find(row => row.kind === 'ai')?.status).toBe('approved');
    expect(current.currentSteps).toEqual([0]); expect(await pending(chief, id)).toHaveLength(0);
    await approve(legal, id); expect(await pending(chief, id)).toHaveLength(1);
  });
  it('另一分支驳回后迟到模型失败不覆盖关闭状态，也不复活活跃节点', async () => {
    const previous = modelReply;
    let entered!: () => void, fail!: (error: Error) => void;
    const generating = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ModelResult>((_resolve, reject) => { fail = reject; });
    modelReply = () => { entered(); return response; };
    try {
      // drain 本身也运行 AI tick，故先启动消费但不等待；等模型进入后再执行另一分支决定。
      const record = await env.kernel.execute('ParallelDocument.create', { scenario: 'ai', amount: '100.00' }, await buyer.ctx());
      const id = record.id as string;
      await env.kernel.execute('ParallelDocument.submit', { id }, await buyer.ctx());
      const running = env.drain();
      await generating;
      const task = (await pending(legal, id))[0];
      await engine.decide(task.id, legal.id, env.tenantId, 'rejected', '人工已确认不通过', task.revision);
      fail(new Error('controlled late provider failure')); await running;
      const current = await history(id);
      expect(current.status).toBe('rejected'); expect(current.currentSteps).toEqual([]);
      expect(current.steps.find(row => row.kind === 'ai')?.status).toBe('skipped');
    } finally { modelReply = previous; }
  });
});
