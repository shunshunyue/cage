/**
 * 用独立真实 PostgreSQL 验证候选任务认领、按字段选人和前后加签的生命周期。
 * 正常实例由领域提交事件和 worker 创建，HTTP 用真实 Cookie/CSRF 会话；直接 SQL 只读取断言结果或制造局部审计故障。
 * 候选身份不授予业务权限，waiting 不代表完成；最终结论仍以最后签署人身份执行领域命令并共同回滚。
 * 每例新建业务对象，组织夹具共享但变更用独立用户；结束时关闭连接并清理测试库，不访问应用数据库。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as org from '@yss123/cage-admin/domain';
import { aggregate, approval, command, enumOf, event, id, list, money, ref, scope, sod, states, systemCtx, text } from '@yss123/cage-kernel';
import { approver, eq, InCodeEngine, route, step, when, type TaskView } from '@yss123/cage-approval';
import { createServer, type CageServer } from '@yss123/cage-http';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

/** 策略仅选择本例节点；金额单位为元，字段审批人保存提交快照，号码用于核对候选列表的脱敏边界。 */
const StagedDocument = aggregate('StagedDocument', {
  fields: {
    createdBy: ref('User'), deptId: ref('Dept'), amount: money(),
    strategy: enumOf('candidate', 'candidate-basic', 'field', 'field-user', 'any', 'all', 'legacy'),
    reviewers: list(text(64)), reviewerId: text(64).optional(), phone: text(32).sensitive('phone'),
  },
  states: states('draft', 'reviewing', 'accepted', 'rejected', 'cancelled', { terminal: ['accepted', 'rejected', 'cancelled'] }),
  scope: scope.of({ dept: 'deptId', owner: 'createdBy' }),
});
/** 提交事件经真实 outbox 消费建立新轮次，不把领域提交完成误认为待办已创建。 */
const Submitted = event('StagedDocumentSubmitted', { id: id() });
/** 取消事件让引擎同时关闭可以处理和尚在等待的任务。 */
const Cancelled = event('StagedDocumentCancelled', { id: id() });
/** 输入允许文本型选人字段，选人器还须明确拒绝非 UUID 内容，不能静默跳过配置错误。 */
const create = command(StagedDocument, { name: 'create', from: 'new', to: 'draft',
  input: z.object({ amount: z.string(), strategy: z.enum(['candidate', 'candidate-basic', 'field', 'field-user', 'any', 'all', 'legacy']),
    reviewers: z.array(z.string()), reviewerId: z.string().optional(), phone: z.string() }), handler: row => row });
/** 普通用户提交；业务状态改变与提交事件在领域事务中提交。 */
const submit = command(StagedDocument, { name: 'submit', from: 'draft', to: 'reviewing', emits: [Submitted], handler: row => row });
/** 最后签署人仍必须满足职责分离，不能沿用更早批准人的身份绕过约束。 */
const accept = command(StagedDocument, { name: 'accept', from: 'reviewing', to: 'accepted', invokedBy: 'process',
  constraints: [sod.notSameAs('createdBy')], handler: row => row });
/** 驳回作为流程结论回到领域命令，不从任务管理入口直接修改业务表。 */
const reject = command(StagedDocument, { name: 'reject', from: 'reviewing', to: 'rejected', invokedBy: 'process', handler: row => row });
/** 退回恢复草稿，后续重提应生成新轮次；不同于释放候选任务。 */
const revise = command(StagedDocument, { name: 'revise', from: 'reviewing', to: 'draft', invokedBy: 'process', handler: row => row });
/** 申请人的取消操作触发同轮次所有 pending/waiting 任务失效。 */
const cancel = command(StagedDocument, { name: 'cancel', from: 'reviewing', to: 'cancelled', emits: [Cancelled], handler: row => row });
/** 仅这些字段可进入路由快照；号码被故意加入，用于验证公开任务摘要不会泄露历史明文。 */
const review = approval(StagedDocument, { process: 'candidate-signing-review', start: Submitted, cancelOn: [Cancelled],
  routable: ['strategy', 'reviewers', 'reviewerId', 'phone'], onApproved: accept, onRejected: reject, onReturned: revise });
/** 新动作显式启用；legacy 分支不传此政策，验证原来已分配待办保持含义。 */
const actions = { transfer: true, delegate: true, addSign: true } as const;
/** 候选角色与原始直派角色分离，新增抢领用户不会改变 all 节点必须完成的两票。 */
const reviewRoute = route('candidate-signing-review', [
  when(eq('strategy', 'candidate'), step('共享候选任务', approver.role('stage_candidates'), { assignment: 'candidate', actions })),
  when(eq('strategy', 'candidate-basic'), step('仅开放候选领取', approver.role('stage_candidates'), { assignment: 'candidate' })),
  when(eq('strategy', 'field'), step('单据字段候选', approver.field('reviewers'), { assignment: 'candidate', actions })),
  when(eq('strategy', 'field-user'), step('单据负责人', approver.field('reviewerId'), { actions })),
  when(eq('strategy', 'any'), step('任一原审批人和全部加签人', approver.role('stage_direct'), { mode: 'any', actions })),
  when(eq('strategy', 'all'), step('全部原审批人和加签人', approver.role('stage_direct'), { mode: 'all', actions })),
  when(eq('strategy', 'legacy'), step('默认直派节点', approver.role('stage_direct'))),
]);
/** 所有声明统一注册，HTTP 与内核消费同一公开路由。 */
const domain = { ...org, StagedDocument, Submitted, Cancelled, create, submit, accept, reject, revise, cancel, review, reviewRoute };
/** read 与结论能力分别列出，使撤权测试能检查选人与授权的独立性。 */
const reviewerCaps = ['StagedDocument.read', 'StagedDocument.accept', 'StagedDocument.reject', 'StagedDocument.revise'];
/** 策略类型只用于夹具输入，与实际声明枚举保持一致。 */
type Strategy = 'candidate' | 'candidate-basic' | 'field' | 'field-user' | 'any' | 'all' | 'legacy';
let env: TestEnv, engine: InCodeEngine, server: CageServer, applicant: TestUser, first: TestUser, second: TestUser, extra: TestUser, another: TestUser;
let candidateRoleId: string;

/** 共用隔离库、两位原始审批人和两位额外签署人；角色只有选人作用，业务能力来自独立用户角色。 */
beforeAll(async () => {
  env = await createTestEnv({ domain }); engine = reviewRoute.engine(env.kernel);
  applicant = await env.user({ caps: ['StagedDocument.read', 'StagedDocument.create', 'StagedDocument.submit', 'StagedDocument.cancel', 'StagedDocument.accept'] });
  first = await reviewer(); second = await reviewer(); extra = await reviewer(); another = await reviewer();
  const candidates = await env.kernel.execute('Role.create', { code: 'stage_candidates', name: '共享任务候选人' }, env.system());
  const direct = await env.kernel.execute('Role.create', { code: 'stage_direct', name: '原始直派审批人' }, env.system());
  candidateRoleId = candidates.id;
  for (const user of [first, second]) await env.kernel.execute('User.assignRoles', { id: user.id, roleIds: [user.roleId, candidates.id, direct.id] }, env.system());
  server = createServer({ domain, urls: env.urls, logger: false, admin: false, authRateLimitPerMinute: 1000 }); await server.ready();
});
/** 连接先关闭再回收测试库，失败用例也不遗留对应用数据库的连接。 */
afterAll(async () => { await server?.close(); await env?.close(); });

/** 新建独立权限角色，默认可读全部单据；需要时加入候选角色。 */
async function reviewer(options: { caps?: string[]; scope?: string; candidate?: boolean } = {}) {
  const user = await env.user({ caps: options.caps ?? reviewerCaps, scopes: { StagedDocument: options.scope ?? 'all' } });
  if (options.candidate) await env.kernel.execute('User.assignRoles', { id: user.id, roleIds: [user.roleId, candidateRoleId] }, env.system());
  return user;
}

/** 创建并提交真实业务对象，worker 处理完后从当前实例核对路由创建结果。 */
async function launch(strategy: Strategy = 'candidate', reviewers = [first.id, second.id], amount = '100.00') {
  const record = await env.kernel.execute('StagedDocument.create', { strategy, reviewers, reviewerId: reviewers[0], amount, phone: '13812345678' }, await applicant.ctx());
  await env.kernel.execute('StagedDocument.submit', { id: record.id }, await applicant.ctx()); await env.drain();
  const instances = await env.query('select id from flow.approval_instance where business_key=$1 and status=\'running\'', [record.id]);
  expect(instances).toHaveLength(1);
  return { id: record.id as string, instanceId: instances[0].id as string };
}

/** 从公开入口读取本人指定状态任务，waiting 明确传入，避免将尚不能签署的任务当作可操作待办。 */
async function owned(user: TestUser, businessKey: string, status = 'pending'): Promise<TaskView> {
  const item = (await engine.tasksOf(user.id, env.tenantId, status)).find(task => task.businessKey === businessKey);
  expect(item).toBeDefined(); return item!;
}

/** 从可领取列表找共享任务；不读取其他候选人的个人任务，也不凭数据库行绕过候选规则。 */
async function candidate(user: TestUser, businessKey: string): Promise<TaskView> {
  const item = (await engine.candidateTasks(user.id, env.tenantId)).find(task => task.businessKey === businessKey);
  expect(item).toBeDefined(); return item!;
}

/** 业务状态从申请人的正常安全读侧读取，区分任务票完成和领域对象已经批准。 */
async function status(businessKey: string) { return (await env.kernel.read.get(StagedDocument, businessKey, await applicant.ctx())).status; }

/** 公开动作历史用来核对原子提交与失败回滚，不根据内存调用次数猜测数据库结果。 */
async function history(businessKey: string) { return (await engine.taskHistory(StagedDocument.name, businessKey, await applicant.ctx(), { limit: 200 })).items; }

/** 指定前/后/并行位置添加真实必签任务，回执只用于返回 ID，状态从公开列表再读取。 */
async function sign(parent: TaskView, actor: TestUser, targets: TestUser[], placement: 'parallel' | 'before' | 'after') {
  return engine.act(parent.id, actor.id, env.tenantId, { action: 'addSign', userIds: targets.map(user => user.id), placement,
    expectedRevision: parent.revision, reason: `${placement} 补充专业意见` });
}

/** 真实登录得到 Cookie/CSRF，不关闭认证保护；随机密码仅用于本隔离库，不输出到日志或源码配置。 */
async function httpActor(user: TestUser) {
  const password = randomUUID(), jar = new Map<string, string>();
  await env.kernel.execute('User.setPassword', { id: user.id, password }, env.system());
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const remember = (response: { cookies: { name: string; value: string }[] }) => { for (const entry of response.cookies) jar.set(entry.name, entry.value); };
  const initial = await server.app.inject({ method: 'GET', url: '/auth/csrf' }); remember(initial);
  const login = await server.app.inject({ method: 'POST', url: '/auth/login', headers: { cookie: cookie(), 'x-csrf-token': initial.json().token },
    payload: { username: user.username, password } });
  expect(login.statusCode).toBe(200); remember(login);
  const token = await server.app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: cookie() } }); remember(token);
  return {
    /** 任务输入不能自行指定可信身份，用户与租户始终来自已登录会话。 */
    post: (url: string, payload: Record<string, unknown>) => server.app.inject({ method: 'POST', url, payload,
      headers: { cookie: cookie(), 'x-csrf-token': token.json().token } }),
    /** 读取候选列表时使用相同会话，让后续撤权覆盖旧登录凭证场景。 */
    get: (url: string) => server.app.inject({ method: 'GET', url, headers: { cookie: cookie() } }),
  };
}

describe('共享候选任务与字段选人', () => {
  it('候选池拒绝 all，字段选择进入路由依赖', () => {
    expect(() => step('非法会签候选池', approver.role('stage_candidates'), { assignment: 'candidate', mode: 'all' })).toThrow();
    expect(reviewRoute.fieldsUsed).toEqual(expect.arrayContaining(['strategy', 'reviewers', 'reviewerId']));
  });

  it('两名候选看到同一个未分配任务，未认领不能审批，候选摘要始终脱敏', async () => {
    const item = await launch(), a = await candidate(first, item.id), b = await candidate(second, item.id);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ assignment: 'candidate', assigneeId: null, revision: 0, parentTaskId: null, signPosition: null, vars: { phone: '138****5678' } });
    expect((await engine.tasksOf(first.id, env.tenantId)).some(task => task.id === a.id)).toBe(false);
    expect(await env.query('select id from flow.approval_task where instance_id=$1', [item.instanceId])).toHaveLength(1);
    await expect(engine.decide(a.id, first.id, env.tenantId, 'approved', undefined, 0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('八位候选同时抢领超过五连接池容量，仅一人成功且只留一条认领历史', async () => {
    const contenders = [first, second];
    for (let index = 0; index < 6; index++) contenders.push(await reviewer({ candidate: true }));
    const item = await launch(), task = await candidate(first, item.id);
    // 所有请求先看到同一 revision，再竞争实例和任务锁；若持锁后另借 app 连接，这组并发会暴露连接池饥饿。
    const results = await Promise.allSettled(contenders.map(user => engine.act(task.id, user.id, env.tenantId,
      { action: 'claim', expectedRevision: 0, reason: '同时领取共享审批' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    expect(failures).toHaveLength(7);
    for (const failure of failures) expect(failure.reason.code).toMatch(/^(CONFLICT|NOT_FOUND)$/);
    const winner = contenders[results.findIndex(result => result.status === 'fulfilled')];
    expect(await owned(winner, item.id)).toMatchObject({ id: task.id, assigneeId: winner.id, revision: 1 });
    expect((await history(item.id)).filter(entry => entry.action === 'claim')).toMatchObject([{ actorId: winner.id }]);
    expect((await engine.candidateTasks(first.id, env.tenantId)).some(row => row.id === task.id)).toBe(false);
    await expect(engine.decide(task.id, winner.id, env.tenantId, 'approved')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await engine.decide(task.id, winner.id, env.tenantId, 'approved', '认领后正式批准', 1);
    expect(await status(item.id)).toBe('accepted');
  });

  it('释放再认领保持单调 revision，旧页面不能决定或重复领取', async () => {
    const item = await launch(), task = await candidate(first, item.id);
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '首次领取' });
    await engine.act(task.id, first.id, env.tenantId, { action: 'unclaim', expectedRevision: 1, reason: '退回候选池' });
    expect(await candidate(second, item.id)).toMatchObject({ id: task.id, assigneeId: null, revision: 2 });
    await expect(engine.act(task.id, second.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '陈旧候选列表' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 2, reason: '重新认领' });
    await expect(engine.decide(task.id, first.id, env.tenantId, 'approved', undefined, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await history(item.id)).map(entry => entry.action)).toEqual(['claim', 'unclaim', 'claim']);
  });

  it('候选领取独立于 actions 开关，未开放转办的候选节点也必须携带决定版本', async () => {
    const item = await launch('candidate-basic'), task = await candidate(first, item.id);
    expect(task.actions).toEqual({});
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '仅用候选领取政策' });
    await expect(engine.act(task.id, first.id, env.tenantId, { action: 'transfer', targetUserId: extra.id, expectedRevision: 1, reason: '未开放转办' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(engine.decide(task.id, first.id, env.tenantId, 'approved')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await engine.decide(task.id, first.id, env.tenantId, 'approved', undefined, 1);
    expect(await status(item.id)).toBe('accepted');
  });

  it('实时撤去候选角色后不能领取，新加入的候选可以看到既有共享任务', async () => {
    const removed = await reviewer({ candidate: true }), added = await reviewer(), item = await launch();
    const task = await candidate(removed, item.id);
    await env.kernel.execute('User.assignRoles', { id: removed.id, roleIds: [removed.roleId] }, env.system());
    expect((await engine.candidateTasks(removed.id, env.tenantId)).some(row => row.id === task.id)).toBe(false);
    await expect(engine.act(task.id, removed.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '已离开候选角色' })).rejects.toMatchObject({ code: expect.stringMatching(/^(NOT_FOUND|FORBIDDEN)$/) });
    await env.kernel.execute('User.assignRoles', { id: added.id, roleIds: [added.roleId, candidateRoleId] }, env.system());
    expect((await candidate(added, item.id)).id).toBe(task.id);
    await engine.act(task.id, added.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '新候选接手存量任务' });
  });

  it.each(['缺批准', '缺读取', '范围外', '停用', '跨租户'] as const)('%s时即使知道候选任务 ID 也不能认领', async boundary => {
    const actor = await reviewer({ candidate: true,
      caps: boundary === '缺批准' ? ['StagedDocument.read'] : boundary === '缺读取' ? ['StagedDocument.accept'] : reviewerCaps,
      scope: boundary === '范围外' ? 'self' : 'all' });
    const item = await launch(), task = await candidate(first, item.id);
    if (boundary === '停用') await env.kernel.execute('User.disable', { id: actor.id }, env.system());
    const tenantId = boundary === '跨租户' ? randomUUID() : env.tenantId;
    expect((await engine.candidateTasks(actor.id, tenantId)).some(row => row.id === task.id)).toBe(false);
    await expect(engine.act(task.id, actor.id, tenantId, { action: 'claim', expectedRevision: 0, reason: '候选资格不授予业务权限' }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^(NOT_FOUND|FORBIDDEN)$/) });
    expect((await candidate(first, item.id)).revision).toBe(0); expect(await history(item.id)).toEqual([]);
  });

  it('认领后撤去候选资格仍可释放，转办到非候选人也保留共享任务属性', async () => {
    const actor = await reviewer({ candidate: true }), item = await launch(), task = await candidate(actor, item.id);
    await engine.act(task.id, actor.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '先合法领取' });
    await env.kernel.execute('User.assignRoles', { id: actor.id, roleIds: [actor.roleId] }, env.system());
    await engine.act(task.id, actor.id, env.tenantId, { action: 'unclaim', expectedRevision: 1, reason: '离开候选角色后释放职责' });
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 2, reason: '其他候选接手' });
    await engine.act(task.id, first.id, env.tenantId, { action: 'transfer', targetUserId: extra.id, expectedRevision: 3, reason: '交给授权专业人员' });
    expect(await owned(extra, item.id)).toMatchObject({ assignment: 'candidate', revision: 4 });
    await engine.act(task.id, extra.id, env.tenantId, { action: 'unclaim', expectedRevision: 4, reason: '专业人员归还候选池' });
    expect(await candidate(second, item.id)).toMatchObject({ assigneeId: null, revision: 5 });
  });

  it('直派不能认领或释放，委派尚未归还时共享任务也不能释放', async () => {
    const direct = await launch('legacy'), original = await owned(first, direct.id);
    expect(original).toMatchObject({ assignment: 'direct', assigneeId: first.id });
    await expect(engine.act(original.id, first.id, env.tenantId,
      { action: 'claim', expectedRevision: 0, reason: '直派不是候选任务' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.act(original.id, first.id, env.tenantId,
      { action: 'unclaim', expectedRevision: 0, reason: '直派任务不能释放' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const item = await launch(), task = await candidate(first, item.id);
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '领取后协助核查' });
    await engine.act(task.id, first.id, env.tenantId, { action: 'delegate', targetUserId: extra.id, expectedRevision: 1, reason: '委派材料复核' });
    await expect(engine.act(task.id, extra.id, env.tenantId, { action: 'unclaim', expectedRevision: 2, reason: '不能遗失原负责人' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await owned(extra, item.id)).toMatchObject({ ownerId: first.id, delegation: 'pending', revision: 2 });
  });

  it.each(['parallel', 'after'] as const)('存在未完成 %s 加签时不能释放候选任务', async placement => {
    const item = await launch(), task = await candidate(first, item.id);
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '领取并补充会审' });
    await sign(await owned(first, item.id), first, [extra], placement);
    await expect(engine.act(task.id, first.id, env.tenantId, { action: 'unclaim', expectedRevision: 2, reason: '不能遗留必签依赖' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await owned(first, item.id)).toMatchObject({ revision: 2 });
  });

  it('字段数组去重但不扩权，单个 UUID 字段能正常直派', async () => {
    const item = await launch('field', [extra.id, extra.id, another.id]), task = await candidate(extra, item.id);
    expect((await candidate(another, item.id)).id).toBe(task.id);
    expect((await engine.candidateTasks(first.id, env.tenantId)).some(row => row.id === task.id)).toBe(false);
    await engine.act(task.id, extra.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '字段指定审批人领取' });
    const single = await launch('field-user', [another.id]);
    expect(await owned(another, single.id)).toMatchObject({ assignment: 'direct', assigneeId: another.id });
    expect(await env.query('select id from flow.approval_task where instance_id=$1', [single.instanceId])).toHaveLength(1);
  });

  it('前签人已经投票后不能再领取同节点原票，释放不压缩独立审批人数', async () => {
    const item = await launch('field', [first.id, extra.id]), task = await candidate(first, item.id);
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '原候选领取' });
    await sign(await owned(first, item.id), first, [extra], 'before');
    await expect(engine.act(task.id, first.id, env.tenantId, { action: 'unclaim', expectedRevision: 2, reason: '前签未完成不能释放' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const child = await owned(extra, item.id); await engine.decide(child.id, extra.id, env.tenantId, 'approved', undefined, child.revision);
    const resumed = await owned(first, item.id);
    await engine.act(task.id, first.id, env.tenantId, { action: 'unclaim', expectedRevision: resumed.revision, reason: '前签完成后释放' });
    const available = await candidate(first, item.id);
    expect((await engine.candidateTasks(extra.id, env.tenantId)).some(row => row.id === task.id)).toBe(false);
    await expect(engine.act(task.id, extra.id, env.tenantId, { action: 'claim', expectedRevision: available.revision, reason: '不能一人承担两票' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([{ value: [] }, { value: ['not-a-uuid'] }, { value: [null] }, { value: null }])('无效字段人选 %j 明确失败且不留下半个流程', async ({ value }) => {
    // 直接调用公开引擎启动事务，验证消费端收到错误快照时的明确失败；不依赖 worker 的延迟重试来推测结果。
    const businessKey = randomUUID();
    await expect(env.kernel.app.transaction().execute(tx => engine.start({ process: reviewRoute.process, businessKey,
      tenantId: env.tenantId, tx, vars: { strategy: 'field', reviewers: value } }))).rejects.toThrow();
    expect(await env.query('select id from flow.approval_instance where business_key=$1', [businessKey])).toHaveLength(0);
  });

  it.each(['停用', '其他租户', '不存在'] as const)('字段包含%s的有效 UUID 时整批选人失败，不只保留有效同事', async boundary => {
    let invalidId = randomUUID();
    if (boundary === '停用') {
      const disabled = await reviewer(); invalidId = disabled.id;
      await env.kernel.execute('User.disable', { id: invalidId }, env.system());
    } else if (boundary === '其他租户') {
      // 同一个隔离库内通过正式组织命令建立另一租户用户，保证验证的是租户不匹配而不是简单的 ID 不存在。
      const tenantId = randomUUID();
      const foreign = systemCtx({ kind: 'system', name: 'test-foreign-tenant', tenantId, capabilities: env.kernel.catalogCaps() });
      const dept = await env.kernel.execute('Dept.create', { name: '其他租户部门', code: 'foreign-root' }, foreign);
      const user = await env.kernel.execute('User.create', { username: `foreign_${randomUUID().slice(0, 8)}`, name: '其他租户审批人', deptId: dept.id }, foreign);
      invalidId = user.id;
    }
    for (const strategy of ['field', 'field-user']) {
      const businessKey = randomUUID();
      await expect(env.kernel.app.transaction().execute(tx => engine.start({ process: reviewRoute.process, businessKey,
        tenantId: env.tenantId, tx, vars: { strategy, reviewers: [first.id, invalidId], reviewerId: invalidId } }))).rejects.toThrow(/CAGE-APPR-007/);
      expect(await env.query('select id from flow.approval_instance where business_key=$1', [businessKey])).toHaveLength(0);
    }
  });

  it('认领写历史失败时 assignee 与 revision 一起回滚', async () => {
    const item = await launch(), task = await candidate(first, item.id);
    await env.query('revoke insert on flow.approval_task_action from cage_app');
    try {
      await expect(engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: 0, reason: '历史必须与认领一起提交' })).rejects.toMatchObject({ code: '42501' });
    } finally { await env.query('grant insert on flow.approval_task_action to cage_app'); }
    expect(await candidate(second, item.id)).toMatchObject({ assigneeId: null, revision: 0 }); expect(await history(item.id)).toEqual([]);
  });
});

describe('前后加签的等待、激活与结论原子性', () => {
  it('旧 addSign 实例没有签序快照时仅开放并行，不能因代码升级自动获得前后签', async () => {
    const item = await launch('any'), parent = await owned(first, item.id);
    expect(parent.signPositions).toEqual(['parallel', 'before', 'after']);
    // 只移除升级前尚不存在的签序字段，保留 addSign=true 和当前路由；验证运行时读取实例政策而非最新代码。
    await env.query("update flow.approval_instance set steps=jsonb_build_array((steps->0)-'signPositions') where id=$1", [item.instanceId]);
    const legacy = await owned(first, item.id);
    expect(legacy.signPositions).toEqual(['parallel']);
    for (const placement of ['before', 'after'] as const)
      await expect(sign(legacy, first, [extra], placement)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await history(item.id)).toEqual([]);
    expect(await env.query('select id from flow.approval_task where instance_id=$1', [item.instanceId])).toHaveLength(2);
    await engine.act(parent.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id], expectedRevision: 0, reason: '旧客户端仍使用默认并行' });
    expect(await owned(extra, item.id)).toMatchObject({ status: 'pending', parentTaskId: parent.id, signPosition: 'parallel' });
    expect(await owned(first, item.id)).toMatchObject({ status: 'pending', revision: 1 });
  });

  it('前签冻结父任务，全部前签通过后才恢复父任务并增加版本', async () => {
    const item = await launch('any'), parent = await owned(first, item.id);
    await sign(parent, first, [extra, another], 'before');
    const waiting = await owned(first, item.id, 'waiting');
    expect(waiting).toMatchObject({ id: parent.id, revision: 1 });
    for (const outcome of ['approved', 'rejected', 'returned'] as const)
      await expect(engine.decide(parent.id, first.id, env.tenantId, outcome, undefined, 1)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(engine.act(parent.id, first.id, env.tenantId, { action: 'transfer', targetUserId: second.id, expectedRevision: 1, reason: '不能绕过等待' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const a = await owned(extra, item.id), b = await owned(another, item.id);
    expect(a).toMatchObject({ parentTaskId: parent.id, signPosition: 'before', assignment: 'direct', taskKind: 'additional' });
    await engine.decide(a.id, extra.id, env.tenantId, 'approved', undefined, a.revision);
    expect((await owned(first, item.id, 'waiting')).revision).toBe(1);
    await engine.decide(b.id, another.id, env.tenantId, 'approved', undefined, b.revision);
    const resumed = await owned(first, item.id);
    expect(resumed).toMatchObject({ id: parent.id, revision: 2 });
    await expect(engine.decide(parent.id, first.id, env.tenantId, 'approved', undefined, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    await engine.decide(parent.id, first.id, env.tenantId, 'approved', undefined, resumed.revision);
    expect(await status(item.id)).toBe('accepted');
  });

  it('any 其他原票通过后仍等待前签，前签完成不会复活已跳过的父任务', async () => {
    const item = await launch('any'), parent = await owned(first, item.id), other = await owned(second, item.id);
    await sign(parent, first, [extra], 'before');
    expect(await engine.decide(other.id, second.id, env.tenantId, 'approved', undefined, other.revision)).toMatchObject({ finished: false });
    expect(await env.query('select status from flow.approval_task where id=$1', [parent.id])).toMatchObject([{ status: 'skipped' }]);
    const child = await owned(extra, item.id); await engine.decide(child.id, extra.id, env.tenantId, 'approved', undefined, child.revision);
    expect(await status(item.id)).toBe('accepted');
    expect(await env.query('select status from flow.approval_task where id=$1', [parent.id])).toMatchObject([{ status: 'skipped' }]);
  });

  it('后签先等待，父批准后才激活，最终领域签署人是后签人', async () => {
    const item = await launch('any'), parent = await owned(first, item.id);
    await sign(parent, first, [extra], 'after');
    const waiting = await owned(extra, item.id, 'waiting');
    expect(waiting).toMatchObject({ parentTaskId: parent.id, signPosition: 'after', assignment: 'direct' });
    await expect(engine.decide(waiting.id, extra.id, env.tenantId, 'approved', undefined, waiting.revision)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await engine.decide(parent.id, first.id, env.tenantId, 'approved', undefined, 1);
    expect(await status(item.id)).toBe('reviewing');
    const ready = await owned(extra, item.id); expect(ready.revision).toBeGreaterThan(waiting.revision);
    await expect(engine.decide(ready.id, extra.id, env.tenantId, 'approved', undefined, waiting.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    await engine.decide(ready.id, extra.id, env.tenantId, 'approved', '最后确认专业意见', ready.revision);
    expect(await env.audit({ aggregateId: item.id, command: 'StagedDocument.accept', kind: 'write' })).toMatchObject([{ on_behalf_of: extra.id }]);
  });

  it('any 由另一原票批准时也激活已跳过父任务的后签，必签人不会永久等待', async () => {
    const item = await launch('any'), parent = await owned(first, item.id), other = await owned(second, item.id);
    await sign(parent, first, [extra], 'after');
    await engine.decide(other.id, second.id, env.tenantId, 'approved', undefined, other.revision);
    expect(await env.query('select status from flow.approval_task where id=$1', [parent.id])).toMatchObject([{ status: 'skipped' }]);
    const child = await owned(extra, item.id); await engine.decide(child.id, extra.id, env.tenantId, 'approved', undefined, child.revision);
    expect(await status(item.id)).toBe('accepted');
  });

  it('all 仅激活自己父任务的后签，并等待另一父任务和其后签全部完成', async () => {
    const item = await launch('all'), a = await owned(first, item.id), b = await owned(second, item.id);
    await sign(a, first, [extra], 'after'); await sign(b, second, [another], 'after');
    await engine.decide(a.id, first.id, env.tenantId, 'approved', undefined, 1);
    expect((await owned(another, item.id, 'waiting')).signPosition).toBe('after');
    const firstChild = await owned(extra, item.id); await engine.decide(firstChild.id, extra.id, env.tenantId, 'approved', undefined, firstChild.revision);
    expect(await status(item.id)).toBe('reviewing');
    await engine.decide(b.id, second.id, env.tenantId, 'approved', undefined, 1);
    const secondChild = await owned(another, item.id); await engine.decide(secondChild.id, another.id, env.tenantId, 'approved', undefined, secondChild.revision);
    expect(await status(item.id)).toBe('accepted');
  });

  it('最后后签人为申请人时职责分离拒绝，决定、版本和历史回滚', async () => {
    const limited = applicant, item = await launch('any'), parent = await owned(first, item.id);
    await sign(parent, first, [limited], 'after'); await engine.decide(parent.id, first.id, env.tenantId, 'approved', undefined, 1);
    const last = await owned(limited, item.id), before = await history(item.id);
    await expect(engine.decide(last.id, limited.id, env.tenantId, 'approved', '申请人不能审批', last.revision)).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATED' });
    expect(await owned(limited, item.id)).toMatchObject({ status: 'pending', revision: last.revision });
    expect(await history(item.id)).toEqual(before); expect(await status(item.id)).toBe('reviewing');
    expect(await env.query('select status from flow.approval_task where id=$1', [parent.id])).toMatchObject([{ status: 'approved' }]);
    expect(await env.audit({ aggregateId: item.id, command: 'StagedDocument.accept', kind: 'write' })).toHaveLength(0);
  });

  it.each(['rejected', 'returned'] as const)('%s 关闭同节点 pending 与 waiting，不让后签晚到决定恢复流程', async outcome => {
    const item = await launch('any'), parent = await owned(first, item.id), other = await owned(second, item.id);
    await sign(parent, first, [extra], 'after'); const waiting = await owned(extra, item.id, 'waiting');
    await engine.decide(other.id, second.id, env.tenantId, outcome, '材料不符合要求', other.revision);
    expect(await status(item.id)).toBe(outcome === 'rejected' ? 'rejected' : 'draft');
    expect(await env.query("select id from flow.approval_task where instance_id=$1 and status in ('pending','waiting')", [item.instanceId])).toHaveLength(0);
    await expect(engine.decide(waiting.id, extra.id, env.tenantId, 'approved', undefined, waiting.revision)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('取消同时关闭等待前签的父任务、前签待办和等待中的后签', async () => {
    const item = await launch('all'), a = await owned(first, item.id), b = await owned(second, item.id);
    await sign(a, first, [extra], 'before'); await sign(b, second, [another], 'after');
    await env.kernel.execute('StagedDocument.cancel', { id: item.id }, await applicant.ctx()); await env.drain();
    const tasks = await env.query('select status from flow.approval_task where instance_id=$1', [item.instanceId]);
    expect(tasks).toHaveLength(4); expect(tasks.every(task => task.status === 'cancelled')).toBe(true);
    expect(await status(item.id)).toBe('cancelled');
  });

  it('八个父批准竞争只激活后签一次，不能重复通过或提前执行领域结论', async () => {
    const item = await launch('any'), parent = await owned(first, item.id); await sign(parent, first, [extra], 'after');
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => engine.decide(parent.id, first.id, env.tenantId, 'approved', '并发确认', 1)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await history(item.id)).filter(entry => entry.action === 'approved')).toHaveLength(1);
    expect((await engine.tasksOf(extra.id, env.tenantId)).filter(task => task.businessKey === item.id)).toHaveLength(1);
    expect(await status(item.id)).toBe('reviewing');
    expect(await env.audit({ aggregateId: item.id, command: 'StagedDocument.accept', kind: 'write' })).toHaveLength(0);
  });
});

describe('候选认领与加签的 HTTP 会话协议', () => {
  it('真实会话可查询候选、认领、前签和释放，未知身份字段与无效 placement 明确拒绝', async () => {
    const item = await launch(), caller = await httpActor(first), task = await candidate(first, item.id);
    const list = await caller.get('/api/approval/candidate-tasks'); expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, assigneeId: null, vars: expect.objectContaining({ phone: '138****5678' }) })]));
    expect(list.body).not.toContain('13812345678');
    for (const payload of [{ expectedRevision: 0, reason: '严格协议', tenantId: randomUUID() }, { expectedRevision: 0, reason: '严格协议', action: 'unclaim' }, { expectedRevision: 0, reason: '   ' }]) {
      const bad = await caller.post(`/api/approval/tasks/${task.id}/claim`, payload); expect(bad.statusCode).toBe(400);
    }
    const claimed = await caller.post(`/api/approval/tasks/${task.id}/claim`, { expectedRevision: 0, reason: 'HTTP 领取' });
    expect(claimed.statusCode).toBe(200); expect(claimed.json()).toMatchObject({ taskId: task.id, revision: 1 });
    const invalid = await caller.post(`/api/approval/tasks/${task.id}/add-sign`, { expectedRevision: 1, reason: '未知签署阶段', userIds: [extra.id], placement: 'middle' });
    expect(invalid.statusCode).toBe(400);
    const before = await caller.post(`/api/approval/tasks/${task.id}/add-sign`, { expectedRevision: 1, reason: '先补充意见', userIds: [extra.id], placement: 'before' });
    expect(before.statusCode).toBe(200); expect((await owned(first, item.id, 'waiting')).revision).toBe(2);
    const child = await owned(extra, item.id); await engine.decide(child.id, extra.id, env.tenantId, 'approved', undefined, child.revision);
    const resumed = await owned(first, item.id);
    const released = await caller.post(`/api/approval/tasks/${task.id}/unclaim`, { expectedRevision: resumed.revision, reason: '前签完成后交回候选池' });
    expect(released.statusCode).toBe(200); expect((await candidate(second, item.id)).assigneeId).toBeNull();
  });

  it('旧 HTTP 会话在候选角色撤销后看不到共享任务且不能领取', async () => {
    const user = await reviewer({ candidate: true }), item = await launch(), caller = await httpActor(user), task = await candidate(user, item.id);
    const initial = await caller.get('/api/approval/candidate-tasks'); expect(initial.json().some((row: TaskView) => row.id === task.id)).toBe(true);
    await env.kernel.execute('User.assignRoles', { id: user.id, roleIds: [user.roleId] }, env.system());
    const hidden = await caller.get('/api/approval/candidate-tasks'); expect(hidden.statusCode).toBe(200); expect(hidden.json()).toEqual([]);
    const failed = await caller.post(`/api/approval/tasks/${task.id}/claim`, { expectedRevision: 0, reason: '旧登录态不能保留候选资格' });
    expect([403, 404]).toContain(failed.statusCode); expect((await candidate(first, item.id)).revision).toBe(0);
  });
});
