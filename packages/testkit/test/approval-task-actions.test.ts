/**
 * 在独立真实 PostgreSQL 中验证人工任务流转、并行必签、实时授权和不可覆盖的操作历史。
 * 夹具通过领域命令提交单据，再由真实 outbox 创建审批；只用测试管理员查询数据库结果，不绕开生产操作入口。
 * any/all/旧节点共用同一绑定，最终批准仍检查职责分离；待办摘要还验证实时读取范围和敏感变量脱敏。
 * 每例创建新单据，组织用户可复用；旧库升级另建隔离库，所有连接与数据库均在结束后回收。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as org from '@yss123/cage-admin/domain';
import { aggregate, approval, buildRegistry, command, enumOf, event, id, MIGRATIONS, money, ok, ref, scope, sod, states, text, violation, type Constraint } from '@yss123/cage-kernel';
import { createTableSql, runMigrations, schemaModel } from '@yss123/cage-kernel/db';
import { approver, eq, InCodeEngine, route, step, when, type TaskView } from '@yss123/cage-approval';
import { createServer, type CageServer } from '@yss123/cage-http';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

/** 金额按两位十进制字符串保存；strategy 只选择本例的审批政策，创建人用于验证转办不能绕过自审批约束。 */
const ActionDocument = aggregate('ActionDocument', {
  fields: {
    createdBy: ref('User'), deptId: ref('Dept'), amount: money(), strategy: enumOf('any', 'all', 'legacy'),
    /** 可选联系号码用于验证历史 routable 摘要不会旁路正式读侧的明文授权和审计。 */
    phone: text(32).sensitive('phone').optional(),
  },
  states: states('draft', 'reviewing', 'accepted', 'rejected', 'cancelled', { terminal: ['accepted', 'rejected', 'cancelled'] }),
  scope: scope.of({ dept: 'deptId', owner: 'createdBy' }),
});
/** 提交事件携带对象 ID；实例创建读取允许的 strategy 并保存该轮次步骤快照。 */
const Submitted = event('ActionDocumentSubmitted', { id: id() });
/** 取消事件交给原审批消费者关闭旧轮次及所有未决任务。 */
const Cancelled = event('ActionDocumentCancelled', { id: id() });
/** 用户新建草稿；createdBy/deptId 由内核写入，测试不从输入伪造创建主体。 */
const create = command(ActionDocument, { name: 'create', from: 'new', to: 'draft',
  input: z.object({ amount: z.string(), strategy: z.enum(['any', 'all', 'legacy']), phone: z.string().optional() }), handler: row => row });
/** 用户提交后等待 outbox 建立真实审批实例，提交成功本身不代表待办已经产生。 */
const submit = command(ActionDocument, { name: 'submit', from: 'draft', to: 'reviewing', emits: [Submitted], handler: row => row });
/**
 * 测试约束读取最终签署人的实时能力，验证命令事务中的能力查询不会再次借用连接池。
 * 缺少真人身份或能力时明确拒绝；此规则只属于测试夹具，不引入金额或改变审批引擎策略。
 */
const requireLiveApprover: Constraint = {
  name: 'requireLiveApprover',
  check: async (_row, ctx, _input, meta) => {
    const userId = ctx.onBehalfOf ?? ctx.userId;
    if (!userId) return violation('缺少可核验的审批人');
    return (await meta.capabilitiesOf(userId)).has(meta.capability) ? ok() : violation('审批人已失去结论能力');
  },
};
/** 最终批准验证职责分离与实时能力查询，保留失败边界以验证共同回滚和并发连接复用。 */
const accept = command(ActionDocument, { name: 'accept', from: 'reviewing', to: 'accepted', invokedBy: 'process',
  constraints: [sod.notSameAs('createdBy'), requireLiveApprover], handler: row => row });
/** 拒绝是流程结论，不能从普通 user 命令入口直接修改业务状态。 */
const reject = command(ActionDocument, { name: 'reject', from: 'reviewing', to: 'rejected', invokedBy: 'process', handler: row => row });
/** 退回把单据恢复草稿；与委派 resolve 的“归还任务”是不同操作。 */
const revise = command(ActionDocument, { name: 'revise', from: 'reviewing', to: 'draft', invokedBy: 'process', handler: row => row });
/** 申请人撤销单据后由 worker 关闭审批，不直接修改 flow 表。 */
const cancel = command(ActionDocument, { name: 'cancel', from: 'reviewing', to: 'cancelled', emits: [Cancelled], handler: row => row });
/** 同一流程绑定三种结论与取消事件；phone 进入持久流程变量，用于覆盖待办公开投影的脱敏边界。 */
const review = approval(ActionDocument, { process: 'task-action-review', start: Submitted, cancelOn: [Cancelled],
  routable: ['strategy', 'phone'], onApproved: accept, onRejected: reject, onReturned: revise });
/** 明确启用的三种人员操作，旧策略不传 actions，验证升级不会自动扩权。 */
const actions = { transfer: true, delegate: true, addSign: true } as const;
/** 条件在创建轮次时展开为一项人工节点；两位 original 用户来自专用角色，追加人不在该角色内。 */
const reviewRoute = route('task-action-review', [
  when(eq('strategy', 'any'), step('任一原审批人和全部加签人', approver.role('task_reviewers'), { mode: 'any', actions })),
  when(eq('strategy', 'all'), step('全部审批人', approver.role('task_reviewers'), { mode: 'all', actions })),
  when(eq('strategy', 'legacy'), step('旧节点', approver.role('task_reviewers'))),
]);
/** 公开声明集中注册，不使用内部临时路由替换实例政策。 */
const domain = { ...org, ActionDocument, Submitted, Cancelled, create, submit, accept, reject, revise, cancel, review, reviewRoute };
/** 审批能力与 read 分开列出，授权拒绝用例可以分别撤销。 */
const reviewerCaps = ['ActionDocument.read', 'ActionDocument.accept', 'ActionDocument.reject', 'ActionDocument.revise'];
let env: TestEnv, engine: InCodeEngine, server: CageServer, applicant: TestUser, first: TestUser, second: TestUser, extra: TestUser, another: TestUser;

/** 创建共用组织与角色；original 角色仅用于选人，真实能力保留在各用户独立角色中。 */
beforeAll(async () => {
  env = await createTestEnv({ domain });
  engine = reviewRoute.engine(env.kernel);
  applicant = await env.user({ caps: ['ActionDocument.read', 'ActionDocument.create', 'ActionDocument.submit', 'ActionDocument.cancel', 'ActionDocument.accept'] });
  first = await reviewer(); second = await reviewer(); extra = await reviewer(); another = await reviewer();
  const originalRole = await env.kernel.execute('Role.create', { code: 'task_reviewers', name: '原始审批人' }, env.system());
  for (const user of [first, second]) await env.kernel.execute('User.assignRoles', { id: user.id, roleIds: [user.roleId, originalRole.id] }, env.system());
  server = createServer({ domain, urls: env.urls, logger: false, admin: false, authRateLimitPerMinute: 1000 });
  await server.ready();
});
/** 由测试环境回收连接池和临时数据库；不修改应用数据库或外部服务。 */
afterAll(async () => { await server?.close(); await env?.close(); });

/** 创建默认可读全部单据的独立审批人；可针对授权边界覆盖能力及范围。 */
async function reviewer(options: { caps?: string[]; scope?: string } = {}) {
  return env.user({ caps: options.caps ?? reviewerCaps, scopes: { ActionDocument: options.scope ?? 'all' } });
}

/** 经用户创建、提交和真实 worker 消费获得当前轮次，返回两位 original 的公开待办快照。 */
async function launch(strategy: 'any' | 'all' | 'legacy' = 'any', amount = '100.00') {
  const record = await env.kernel.execute('ActionDocument.create', { strategy, amount, phone: '13812345678' }, await applicant.ctx());
  await env.kernel.execute('ActionDocument.submit', { id: record.id }, await applicant.ctx());
  await env.drain();
  const a = (await engine.tasksOf(first.id, env.tenantId)).find(task => task.businessKey === record.id)!;
  const b = (await engine.tasksOf(second.id, env.tenantId)).find(task => task.businessKey === record.id)!;
  expect(a).toBeDefined(); expect(b).toBeDefined();
  return { id: record.id as string, a, b };
}

/** 读取指定对象对应的本人未决待办；不存在就断言失败，避免错误夹具被后续空值掩盖。 */
async function pending(user: TestUser, businessKey: string): Promise<TaskView> {
  const task = (await engine.tasksOf(user.id, env.tenantId)).find(item => item.businessKey === businessKey);
  expect(task).toBeDefined(); return task!;
}

/** 读取已授权申请人的业务状态，用于区分任务完成与领域结论实际提交。 */
async function status(businessKey: string) {
  return (await env.kernel.read.get(ActionDocument, businessKey, await applicant.ctx())).status;
}

/** 获取对象的公开任务动作历史；断言依据实际持久记录，不按预期调用次数伪造成功。 */
async function history(businessKey: string) {
  return (await engine.taskHistory(ActionDocument.name, businessKey, await applicant.ctx(), { limit: 200 })).items;
}

/**
 * 通过真实密码登录取得独立 Cookie/CSRF 会话，再调用 Fastify 注入路由。
 * 密码为测试期间随机生成且只用于当前隔离库；不关闭 CSRF、不伪造请求身份，也不启动浏览器或监听端口。
 */
async function httpActor(user: TestUser) {
  const password = randomUUID(), jar = new Map<string, string>();
  await env.kernel.execute('User.setPassword', { id: user.id, password }, env.system());
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const remember = (response: { cookies: { name: string; value: string }[] }) => {
    for (const item of response.cookies) jar.set(item.name, item.value);
  };
  const initial = await server.app.inject({ method: 'GET', url: '/auth/csrf' });
  remember(initial);
  const login = await server.app.inject({ method: 'POST', url: '/auth/login',
    headers: { cookie: cookie(), 'x-csrf-token': initial.json().token }, payload: { username: user.username, password } });
  expect(login.statusCode).toBe(200); remember(login);
  const refreshed = await server.app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: cookie() } });
  remember(refreshed);
  return {
    /** 每次请求继续使用独立 Cookie 罐和已验证令牌，业务 body 不包含可信 user/tenant 信息。 */
    post: (url: string, payload: Record<string, unknown>) => server.app.inject({ method: 'POST', url, payload,
      headers: { cookie: cookie(), 'x-csrf-token': refreshed.json().token } }),
    /** 历史查询走相同会话的安全读取路径。 */
    get: (url: string) => server.app.inject({ method: 'GET', url, headers: { cookie: cookie() } }),
  };
}

describe('人工任务转办、委派与授权边界', () => {
  it('转办只移交待办责任，旧人失权、旧 revision 冲突，最终结论使用新人的身份', async () => {
    const item = await launch();
    expect(item.a).toMatchObject({ revision: 0, taskKind: 'original', ownerId: null, delegation: null, actions });
    const receipt = await engine.act(item.a.id, first.id, env.tenantId, { action: 'transfer', targetUserId: extra.id, expectedRevision: 0, reason: '交由专业审核人复核' });
    expect(receipt).toEqual({ taskId: item.a.id, revision: 1, createdTaskIds: [] });
    expect(await status(item.id)).toBe('reviewing');
    await expect(engine.decide(item.a.id, first.id, env.tenantId, 'approved', undefined, 0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.decide(item.a.id, extra.id, env.tenantId, 'approved', undefined, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(engine.decide(item.a.id, extra.id, env.tenantId, 'approved')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await engine.decide(item.a.id, extra.id, env.tenantId, 'approved', '复核完成', 1)).toMatchObject({ finished: true });
    expect(await status(item.id)).toBe('accepted');
    const entries = await history(item.id);
    expect(entries.filter(entry => entry.action === 'transfer')).toMatchObject([{ actorId: first.id, reason: '交由专业审核人复核', details: { from: first.id, to: extra.id, revision: 1 } }]);
    expect(entries.find(entry => entry.action === 'approved')).toMatchObject({ actorId: extra.id, reason: '复核完成' });
    expect(await env.audit({ aggregateId: item.id, command: 'ActionDocument.accept', kind: 'write' })).toMatchObject([{ on_behalf_of: extra.id }]);
  });

  it('委派期间禁止结论和嵌套操作，归还只恢复原审批人，完整保留三步历史', async () => {
    const item = await launch();
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'delegate', targetUserId: extra.id, expectedRevision: 0, reason: '请协助核查材料' });
    expect(await pending(extra, item.id)).toMatchObject({ ownerId: first.id, delegation: 'pending', revision: 1 });
    for (const outcome of ['approved', 'rejected', 'returned'] as const)
      await expect(engine.decide(item.a.id, extra.id, env.tenantId, outcome, undefined, 1)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    for (const action of ['transfer', 'delegate'] as const)
      await expect(engine.act(item.a.id, extra.id, env.tenantId, { action, targetUserId: another.id, expectedRevision: 1, reason: '尝试嵌套移交' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(engine.act(item.a.id, extra.id, env.tenantId, { action: 'addSign', userIds: [another.id], expectedRevision: 1, reason: '尝试嵌套加签' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await engine.act(item.a.id, extra.id, env.tenantId, { action: 'resolve', expectedRevision: 1, reason: '材料核查完毕' });
    expect(await status(item.id)).toBe('reviewing');
    expect(await pending(first, item.id)).toMatchObject({ ownerId: first.id, delegation: 'resolved', revision: 2 });
    await expect(engine.decide(item.a.id, extra.id, env.tenantId, 'approved', undefined, 2)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await engine.decide(item.a.id, first.id, env.tenantId, 'approved', '由原审批人确认', 2);
    expect((await history(item.id)).filter(entry => ['delegate', 'resolve', 'approved'].includes(entry.action)).map(entry => entry.action)).toEqual(['delegate', 'resolve', 'approved']);
  });

  it('转出又转回同一人后旧页面的 revision 仍失效，不能只比较当前 assignee', async () => {
    const item = await launch();
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'transfer', targetUserId: extra.id, expectedRevision: 0, reason: '先交专业人员复核' });
    await engine.act(item.a.id, extra.id, env.tenantId, { action: 'transfer', targetUserId: first.id, expectedRevision: 1, reason: '复核后交回原审批人' });
    expect(await pending(first, item.id)).toMatchObject({ revision: 2, ownerId: null });
    // 此时身份与初始快照完全相同，唯有单调版本能区分移交前的页面；拒绝后不能留决定流水。
    const before = await history(item.id);
    await expect(engine.decide(item.a.id, first.id, env.tenantId, 'approved', '陈旧页面提交', 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await status(item.id)).toBe('reviewing');
    expect(await history(item.id)).toEqual(before);
    expect(await engine.decide(item.a.id, first.id, env.tenantId, 'approved', '重新载入后确认', 2)).toMatchObject({ finished: true });
  });

  it('拒绝本人、重复加签和同节点已有审批人，不留部分任务或动作', async () => {
    const item = await launch(), initial = await history(item.id);
    await expect(engine.act(item.a.id, first.id, env.tenantId, { action: 'transfer', targetUserId: first.id, expectedRevision: 0, reason: '转给自己' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(engine.act(item.a.id, first.id, env.tenantId, { action: 'delegate', targetUserId: second.id, expectedRevision: 0, reason: '合并两人职责' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id, extra.id], expectedRevision: 0, reason: '重复人选' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id, second.id], expectedRevision: 0, reason: '包含已存在人选' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await pending(first, item.id)).toMatchObject({ revision: 0 });
    expect(await history(item.id)).toEqual(initial);
    expect(await env.query('select id from flow.approval_task where instance_id=$1', [item.a.instanceId])).toHaveLength(2);
  });

  it('目标缺能力、缺 read、范围外或停用，以及伪造租户均不能移交', async () => {
    const item = await launch();
    const noApprove = await reviewer({ caps: ['ActionDocument.read'] });
    const noRead = await reviewer({ caps: ['ActionDocument.accept'] });
    const outOfScope = await reviewer({ scope: 'self' });
    const disabled = await reviewer();
    await env.kernel.execute('User.disable', { id: disabled.id }, env.system());
    for (const [target, code] of [[noApprove, 'FORBIDDEN'], [noRead, 'FORBIDDEN'], [outOfScope, 'NOT_FOUND'], [disabled, 'FORBIDDEN']] as const)
      await expect(engine.act(item.a.id, first.id, env.tenantId, { action: 'transfer', targetUserId: target.id, expectedRevision: 0, reason: '检验目标资格' })).rejects.toMatchObject({ code });
    await expect(engine.act(item.a.id, first.id, randomUUID(), { action: 'transfer', targetUserId: extra.id, expectedRevision: 0, reason: '伪造其他租户' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.act(item.a.id, extra.id, env.tenantId, { action: 'transfer', targetUserId: another.id, expectedRevision: 0, reason: '操作他人待办' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await pending(first, item.id)).toMatchObject({ revision: 0 });
    expect((await history(item.id)).filter(entry => entry.action === 'transfer')).toHaveLength(0);
  });

  it('转办后实时撤权阻止继续操作，归还时也重新检查原负责人', async () => {
    const item = await launch(), target = await reviewer();
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'transfer', targetUserId: target.id, expectedRevision: 0, reason: '交接审核' });
    await env.kernel.execute('Role.revokeCapability', { id: target.roleId, capability: 'ActionDocument.accept' }, env.system());
    await expect(engine.act(item.a.id, target.id, env.tenantId, { action: 'delegate', targetUserId: extra.id, expectedRevision: 1, reason: '已撤权不能委派' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(engine.decide(item.a.id, target.id, env.tenantId, 'approved', undefined, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await env.kernel.execute('Role.grantCapability', { id: target.roleId, capability: 'ActionDocument.accept' }, env.system());
    await engine.act(item.a.id, target.id, env.tenantId, { action: 'delegate', targetUserId: extra.id, expectedRevision: 1, reason: '恢复资格后委派' });
    await env.kernel.execute('User.disable', { id: target.id }, env.system());
    await expect(engine.act(item.a.id, extra.id, env.tenantId, { action: 'resolve', expectedRevision: 2, reason: '不能归还给停用用户' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await pending(extra, item.id)).toMatchObject({ revision: 2, delegation: 'pending' });
  });
});

describe('并行必签、共同回滚与竞争', () => {
  it('any 原审批人胜出仅跳过其他 original，所有 additional 批准后才完成', async () => {
    const item = await launch();
    const added = await engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id, another.id], expectedRevision: 0, reason: '补充两项专业审核' });
    expect(added.createdTaskIds).toHaveLength(2);
    expect(await engine.decide(item.a.id, first.id, env.tenantId, 'approved', undefined, 1)).toEqual({ finished: false });
    expect((await env.query('select status from flow.approval_task where id=$1', [item.b.id]))[0].status).toBe('skipped');
    expect((await history(item.id)).filter(entry => entry.action === 'skipped')).toMatchObject([
      { actorId: first.id, details: { cause: 'any_approved', taskIds: [item.b.id] } },
    ]);
    const c = await pending(extra, item.id), d = await pending(another, item.id);
    expect(c).toMatchObject({ taskKind: 'additional', revision: 0 });
    await expect(engine.act(c.id, extra.id, env.tenantId, { action: 'addSign', userIds: [(await reviewer()).id], expectedRevision: 0, reason: '加签人不能扩展责任' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await engine.decide(c.id, extra.id, env.tenantId, 'approved', undefined, 0)).toEqual({ finished: false });
    expect(await status(item.id)).toBe('reviewing');
    expect(await engine.decide(d.id, another.id, env.tenantId, 'approved', undefined, 0)).toMatchObject({ finished: true });
    expect(await status(item.id)).toBe('accepted');
    expect(await env.audit({ aggregateId: item.id, command: 'ActionDocument.accept', kind: 'write' })).toMatchObject([{ on_behalf_of: another.id }]);
  });

  it('any 的 additional 先完成不能代替原始审批票', async () => {
    const item = await launch();
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id], expectedRevision: 0, reason: '先做专业核查' });
    const c = await pending(extra, item.id);
    expect(await engine.decide(c.id, extra.id, env.tenantId, 'approved', undefined, 0)).toEqual({ finished: false });
    expect(await status(item.id)).toBe('reviewing');
    expect(await engine.decide(item.b.id, second.id, env.tenantId, 'approved', undefined, 0)).toMatchObject({ finished: true });
  });

  it('all 等待两位 original 和全部 additional，不因一人批准提前结束', async () => {
    const item = await launch('all');
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id], expectedRevision: 0, reason: '共同签署' });
    const c = await pending(extra, item.id);
    expect(await engine.decide(item.a.id, first.id, env.tenantId, 'approved', undefined, 1)).toEqual({ finished: false });
    expect(await engine.decide(c.id, extra.id, env.tenantId, 'approved', undefined, 0)).toEqual({ finished: false });
    expect(await pending(second, item.id)).toMatchObject({ status: 'pending' });
    expect(await engine.decide(item.b.id, second.id, env.tenantId, 'approved', undefined, 0)).toMatchObject({ finished: true });
  });

  it.each(['rejected', 'returned'] as const)('additional 的 %s 结论终止当前轮次并关闭所有其他未决', async outcome => {
    const item = await launch();
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id, another.id], expectedRevision: 0, reason: '补充两项复核' });
    const c = await pending(extra, item.id), d = await pending(another, item.id);
    expect(await engine.decide(c.id, extra.id, env.tenantId, outcome, '材料不满足要求', 0)).toMatchObject({ finished: true, outcome });
    expect(await status(item.id)).toBe(outcome === 'rejected' ? 'rejected' : 'draft');
    expect(await env.query("select id from flow.approval_task where instance_id=$1 and status='pending'", [item.a.instanceId])).toHaveLength(0);
    const skipped = (await history(item.id)).filter(entry => entry.action === 'skipped');
    expect(skipped).toMatchObject([{ actorId: extra.id, details: { cause: outcome } }]);
    expect((skipped[0].details.taskIds as string[]).sort()).toEqual([item.a.id, item.b.id, d.id].sort());
  });

  it('最后加签人为申请人时职责分离拒绝，决定、版本和历史回滚', async () => {
    const item = await launch(), limited = applicant;
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [limited.id], expectedRevision: 0, reason: '申请人参与核查' });
    await engine.decide(item.a.id, first.id, env.tenantId, 'approved', undefined, 1);
    const last = await pending(limited, item.id), initialHistory = await history(item.id);
    await expect(engine.decide(last.id, limited.id, env.tenantId, 'approved', '专业确认', 0)).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATED' });
    expect(await pending(limited, item.id)).toMatchObject({ revision: 0, status: 'pending' });
    expect(await status(item.id)).toBe('reviewing');
    expect(await history(item.id)).toEqual(initialHistory);
    expect(await env.audit({ aggregateId: item.id, command: 'ActionDocument.accept', kind: 'write' })).toHaveLength(0);
  });

  it('操作流水无法写入时转办和任务版本一起回滚，不出现已转办但无证据', async () => {
    const item = await launch(), initialHistory = await history(item.id);
    // 仅在本文件独立测试库撤销写权限制造可靠审计故障；finally 恢复，防止后续用例继承故障。
    await env.query('revoke insert on flow.approval_task_action from cage_app');
    try {
      await expect(engine.act(item.a.id, first.id, env.tenantId, {
        action: 'transfer', targetUserId: extra.id, expectedRevision: 0, reason: '审计故障必须整体失败',
      })).rejects.toMatchObject({ code: '42501' });
    } finally { await env.query('grant insert on flow.approval_task_action to cage_app'); }
    expect(await pending(first, item.id)).toMatchObject({ revision: 0, ownerId: null });
    expect(await history(item.id)).toEqual(initialHistory);
  });

  it('八个旧 revision 请求超过五个连接并发时仅提交一次且不死锁', async () => {
    const item = await launch();
    // 测试环境 app 池只有五个连接；持有实例锁时若再从同池读取身份，八个请求会耗尽池并互相等待。
    // 每个请求都使用同一版本和目标，合法串行结果只能创建一票；其余请求必须在锁内得到版本冲突。
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => engine.act(item.a.id, first.id, env.tenantId,
      { action: 'addSign', userIds: [extra.id], expectedRevision: 0, reason: '并发提交补充审核人' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(7);
    for (const result of rejected) expect(result.reason).toMatchObject({ code: 'CONFLICT' });
    expect(await env.query("select id from flow.approval_task where instance_id=$1 and task_kind='additional'", [item.a.instanceId])).toHaveLength(1);
    expect((await history(item.id)).filter(entry => entry.action === 'addSign')).toHaveLength(1);
  });

  it('八个最终批准竞争时约束复用事务连接，业务结论仅提交一次', async () => {
    const item = await launch();
    // 最终批准的测试约束会查询真人实时能力；若持锁后再次借用池连接，并发等待者会耗尽五个连接。
    // 胜者结束实例后其余请求应明确得到状态拒绝，不能产生重复业务写入或重复批准历史。
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      engine.decide(item.a.id, first.id, env.tenantId, 'approved', '并发确认', 0)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(7);
    for (const result of rejected) expect(result.reason).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await status(item.id)).toBe('accepted');
    expect((await history(item.id)).filter(entry => entry.action === 'approved')).toHaveLength(1);
    expect(await env.audit({ aggregateId: item.id, command: 'ActionDocument.accept', kind: 'write' })).toHaveLength(1);
  });

  it('取消关闭委派与加签待办，晚到操作被拒绝且历史保留', async () => {
    const item = await launch();
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'addSign', userIds: [extra.id], expectedRevision: 0, reason: '加入专业审核' });
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'delegate', targetUserId: another.id, expectedRevision: 1, reason: '临时协助' });
    await env.kernel.execute('ActionDocument.cancel', { id: item.id }, await applicant.ctx()); await env.drain();
    await expect(engine.act(item.a.id, another.id, env.tenantId, { action: 'resolve', expectedRevision: 2, reason: '晚到处理结果' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await env.query("select id from flow.approval_task where instance_id=$1 and status='pending'", [item.a.instanceId])).toHaveLength(0);
    expect((await history(item.id)).map(entry => entry.action)).toEqual(expect.arrayContaining(['addSign', 'delegate', 'cancelled']));
  });

  it('旧节点不开放新操作，原无 revision 的决定保持兼容', async () => {
    const item = await launch('legacy');
    expect(item.a.actions).toEqual({});
    await expect(engine.act(item.a.id, first.id, env.tenantId, { action: 'transfer', targetUserId: extra.id, expectedRevision: 0, reason: '旧节点未授权' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await engine.decide(item.a.id, first.id, env.tenantId, 'approved', '旧客户端确认')).toMatchObject({ finished: true });
  });

  it('旧实例快照不因当前路由已开放操作而自动获得新政策', async () => {
    const item = await launch();
    // 模拟升级前已持久化的实例，而当前 reviewRoute 仍开启全部 actions；不能改 route 来伪造兼容通过。
    await env.query("update flow.approval_instance set steps=jsonb_build_array((steps->0)-'actions') where id=$1", [item.a.instanceId]);
    expect((await pending(first, item.id)).actions).toEqual({});
    await expect(engine.act(item.a.id, first.id, env.tenantId, {
      action: 'addSign', userIds: [extra.id], expectedRevision: 0, reason: '不能升级旧轮次权限',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await engine.decide(item.a.id, first.id, env.tenantId, 'approved')).toMatchObject({ finished: true });
  });

  it('历史受当前 read 范围保护，应用数据库账号不能改写已保存动作', async () => {
    const item = await launch(), outsider = await reviewer({ scope: 'self' });
    await engine.act(item.a.id, first.id, env.tenantId, { action: 'transfer', targetUserId: extra.id, expectedRevision: 0, reason: '需要保留的移交记录' });
    await expect(engine.taskHistory(ActionDocument.name, item.id, await outsider.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const entry = (await history(item.id)).find(row => row.action === 'transfer')!;
    await expect(env.kernel.app.updateTable('flow.approval_task_action').set({ reason: '试图篡改' }).where('id', '=', entry.id).execute()).rejects.toMatchObject({ code: '42501' });
    await expect(env.kernel.app.deleteFrom('flow.approval_task_action').where('id', '=', entry.id).execute()).rejects.toMatchObject({ code: '42501' });
    expect((await history(item.id)).find(row => row.id === entry.id)?.reason).toBe('需要保留的移交记录');
  });
});

describe('真实旧审批数据库的前向升级', () => {
  it('保留已存在待办和旧政策，仅追加新迁移且重复执行不改历史', async () => {
    // 保持正式 FLOW_DDL 与 AI 迁移原文，仅从测试注册表排除本次扩展，以实际生成升级前审批结构。
    // 不在新版库删列来伪造旧库，也不手改已执行迁移的 checksum；首次提交通过正常领域和 worker 产生旧待办。
    const originalRoute = route('task-action-review', [step('升级前人工节点', approver.role('task_reviewers'))]);
    const priorRoute = { ...originalRoute, [MIGRATIONS]: () => originalRoute[MIGRATIONS]().filter(m => m.name === 'cage:approval_ai_001') };
    const prior = await createTestEnv({ domain: { ...domain, reviewRoute: priorRoute } });
    try {
      const submitter = await prior.user({ caps: ['ActionDocument.read', 'ActionDocument.create', 'ActionDocument.submit'] });
      const reviewer = await prior.user({ caps: reviewerCaps, scopes: { ActionDocument: 'all' } });
      const role = await prior.kernel.execute('Role.create', { code: 'task_reviewers', name: '旧版审批角色' }, prior.system());
      await prior.kernel.execute('User.assignRoles', { id: reviewer.id, roleIds: [reviewer.roleId, role.id] }, prior.system());
      const subject = await prior.kernel.execute('ActionDocument.create', { amount: '100.00', strategy: 'any' }, await submitter.ctx());
      await prior.kernel.execute('ActionDocument.submit', { id: subject.id }, await submitter.ctx());
      await prior.drain();
      const before = await prior.query('select t.* from flow.approval_task t join flow.approval_instance i on i.id=t.instance_id where i.business_key=$1', [subject.id]);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ assignee: reviewer.id, status: 'pending', title: '升级前人工节点' });
      expect(before[0]).not.toHaveProperty('revision');
      expect((await prior.query("select to_regclass('flow.approval_task_action') as relation"))[0].relation).toBeNull();
      const checksums = await prior.query('select name, checksum from sys.schema_migrations order by name');
      const baseline = { name: '0001_test_schema', sql: schemaModel(prior.kernel.registry).tables.map(createTableSql).join('\n\n') };
      const registry = buildRegistry(domain);
      const upgraded = await runMigrations({ migrateUrl: prior.urls.migrate, registry, migrations: [baseline] });
      expect(upgraded).toEqual({ applied: ['cage:approval_task_actions_001', 'cage:approval_task_stages_002', 'cage:approval_deadlines_003'], safeLayerRebuilt: true });
      const after = await prior.query('select * from flow.approval_task where id=$1', [before[0].id]);
      expect(after[0]).toMatchObject({ ...before[0], revision: 0, owner_id: null, delegation: null, task_kind: 'original', assignment: 'direct', parent_task_id: null, sign_position: null });
      expect(await prior.query('select * from flow.approval_task_action')).toEqual([]);
      const updatedChecksums = await prior.query('select name, checksum from sys.schema_migrations order by name');
      expect(updatedChecksums.filter(row => !['cage:approval_task_actions_001', 'cage:approval_task_stages_002', 'cage:approval_deadlines_003'].includes(row.name))).toEqual(checksums);
      // 时效迁移只增加可空政策与节点时间，升级旧轮次不会自动开放催办或开始新的计时。
      expect((await prior.query('select reminder_policy, next_urge_at from flow.approval_instance where id=$1', [before[0].instance_id]))[0])
        .toEqual({ reminder_policy: null, next_urge_at: null });
      expect((await prior.query('select due_at, remind_at from flow.approval_step where instance_id=$1', [before[0].instance_id]))[0])
        .toEqual({ due_at: null, remind_at: null });
      expect(await runMigrations({ migrateUrl: prior.urls.migrate, registry, migrations: [baseline] })).toEqual({ applied: [], safeLayerRebuilt: true });
      expect(await prior.query('select name, checksum from sys.schema_migrations order by name')).toEqual(updatedChecksums);

      // 引擎采用当前已启用 actions 的路由，但必须继续遵守旧实例保存的无 actions 快照；旧客户端仍可完成原待办。
      const upgradedEngine = new InCodeEngine(prior.kernel, reviewRoute);
      const task = (await upgradedEngine.tasksOf(reviewer.id, prior.tenantId))[0];
      expect(task).toMatchObject({ id: before[0].id, revision: 0, taskKind: 'original', actions: {} });
      await expect(upgradedEngine.act(task.id, reviewer.id, prior.tenantId, {
        action: 'transfer', targetUserId: submitter.id, expectedRevision: 0, reason: '旧实例不能自动开放动作',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await upgradedEngine.decide(task.id, reviewer.id, prior.tenantId, 'approved', '升级后继续旧审批')).toMatchObject({ finished: true });
      expect((await prior.kernel.read.get(ActionDocument, subject.id, await submitter.ctx())).status).toBe('accepted');
    } finally { await prior.close(); }
  });
});

describe('人工任务 HTTP 协议与会话边界', () => {
  it.each(['撤销读取', '范围改为本人', '停用用户'] as const)('转办后%s，已有待办不能继续从引擎或 HTTP 列表读取', async change => {
    const item = await launch(), target = await reviewer(), caller = await httpActor(target);
    await engine.act(item.a.id, first.id, env.tenantId, {
      action: 'transfer', targetUserId: target.id, expectedRevision: 0, reason: '先合法接收再验证实时权限变化',
    });
    expect(await pending(target, item.id)).toMatchObject({ id: item.a.id, revision: 1 });
    const visible = await caller.get('/api/approval/tasks');
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: item.a.id })]));

    // 在旧会话已经读过待办后收紧授权，列表必须重新验证对象；任务仍归原人不构成永久读取权。
    if (change === '撤销读取') await env.kernel.execute('Role.revokeCapability', { id: target.roleId, capability: 'ActionDocument.read' }, env.system());
    else if (change === '范围改为本人') await env.kernel.execute('Role.setScope', { id: target.roleId, aggregate: 'ActionDocument', combinator: 'self' }, env.system());
    else await env.kernel.execute('User.disable', { id: target.id }, env.system());
    expect((await engine.tasksOf(target.id, env.tenantId)).some(task => task.id === item.a.id)).toBe(false);
    const hidden = await caller.get('/api/approval/tasks');
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual([]);
    expect(await env.query('select assignee, status, revision from flow.approval_task where id=$1', [item.a.id]))
      .toMatchObject([{ assignee: target.id, status: 'pending', revision: 1 }]);
  });

  it('待办历史变量即使对有明文能力的人也脱敏，明文必须走正式业务读取', async () => {
    const item = await launch(), target = await reviewer({ caps: [...reviewerCaps, 'ActionDocument.unmask.phone'] });
    const caller = await httpActor(target);
    await engine.act(item.a.id, first.id, env.tenantId, {
      action: 'transfer', targetUserId: target.id, expectedRevision: 0, reason: '检验历史变量展示边界',
    });
    // 流程确实持有原始号码，避免误把上游已经脱敏的输入当作本次公开投影正确的证据。
    expect((await env.query('select vars from flow.approval_instance where id=$1', [item.a.instanceId]))[0].vars.phone).toBe('13812345678');
    expect((await pending(target, item.id)).vars).toMatchObject({ strategy: 'any', phone: '138****5678' });
    const response = await caller.get('/api/approval/tasks');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ id: item.a.id, vars: { phone: '138****5678' } }]);
    expect(response.body).not.toContain('13812345678');
    expect((await env.kernel.read.get(ActionDocument, item.id, await target.ctx())).phone).toBe('13812345678');
  });

  it('真实 Cookie/CSRF 会话可转办并查询动作历史，原执行人不能继续决定', async () => {
    const item = await launch(), caller = await httpActor(first);
    const result = await caller.post(`/api/approval/tasks/${item.a.id}/transfer`, {
      targetUserId: extra.id, expectedRevision: 0, reason: 'HTTP 正常移交',
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ taskId: item.a.id, revision: 1, createdTaskIds: [] });
    const oldDecision = await caller.post(`/api/approval/tasks/${item.a.id}/approve`, { expectedRevision: 1 });
    expect(oldDecision.statusCode).toBe(404);
    const records = await caller.get(`/api/approval/task-history/task-action-review/ActionDocument/${item.id}`);
    expect(records.statusCode).toBe(200);
    expect(records.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'transfer', reason: 'HTTP 正常移交' })]));
  });

  it('HTTP 严格拒绝伪造 action、未知属性和缺任务版本的决定，任务保持未决', async () => {
    const item = await launch(), caller = await httpActor(first);
    const valid = { targetUserId: extra.id, expectedRevision: 0, reason: '检查严格协议' };
    for (const payload of [{ ...valid, action: 'delegate' }, { ...valid, tenantId: randomUUID() }, { ...valid, reason: '   ' }]) {
      const result = await caller.post(`/api/approval/tasks/${item.a.id}/transfer`, payload);
      expect(result.statusCode).toBe(400); expect(result.json().code).toBe('INVALID_INPUT');
    }
    const decision = await caller.post(`/api/approval/tasks/${item.a.id}/approve`, { comment: '缺版本不能批准' });
    expect(decision.statusCode).toBe(400); expect(decision.json().code).toBe('INVALID_INPUT');
    expect(await pending(first, item.id)).toMatchObject({ status: 'pending', revision: 0 });
  });

  it('HTTP 登录用户仍不能管理他人的任务或读取范围外历史', async () => {
    const item = await launch(), outsider = await reviewer({ scope: 'self' }), caller = await httpActor(outsider);
    const result = await caller.post(`/api/approval/tasks/${item.a.id}/delegate`, {
      targetUserId: extra.id, expectedRevision: 0, reason: '登录不等于持有待办',
    });
    expect(result.statusCode).toBe(404);
    const records = await caller.get(`/api/approval/task-history/task-action-review/ActionDocument/${item.id}`);
    expect(records.statusCode).toBe(404);
    expect(await pending(first, item.id)).toMatchObject({ revision: 0 });
  });
});
