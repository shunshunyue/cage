/**
 * 框架流程时效的真实 PostgreSQL 回归：声明、worker、HTTP 会话、权限、催办冷却与已读共用实际实现。
 * 夹具是独立通用单据，不依赖采购项目；自然时间使用六秒 SLA，轮询等待持久扫描，不伪造时钟或改 due_at。
 * 只有回滚用例通过测试管理员安装局部失败触发器；业务成功路径全部经过领域命令和审批公开服务。
 * 每例独立单据，结束后关闭两个内核、会话服务器及临时库；不触碰真实应用数据库。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as org from '@yss123/cage-admin/domain';
import { aggregate, approval, buildRegistry, command, enumOf, event, id, ref, scope, states } from '@yss123/cage-kernel';
import { approver, approvalOperations, approvalOperationsService, eq, route, step, when } from '@yss123/cage-approval';
import { createServer, type CageServer } from '@yss123/cage-http';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

/** 每张单据只有真实申请人和签署策略；申请人由内核写入，创建输入不能冒用他人。 */
const TimedDocument = aggregate('TimedDocument', {
  fields: { createdBy: ref('User'), strategy: enumOf('direct', 'candidate') },
  states: states('draft', 'reviewing', 'accepted', 'rejected', 'cancelled', { terminal: ['accepted', 'rejected', 'cancelled'] }),
  scope: scope.self('createdBy'),
});
/** 提交与取消由 outbox 把领域生命周期传给审批引擎，避免直接伪造流程表。 */
const Submitted = event('TimedDocumentSubmitted', { id: id() });
const Cancelled = event('TimedDocumentCancelled', { id: id() });
/** 命令分别承载创建、提交、取消和流程结论；测试用户必须具有对应能力。 */
const create = command(TimedDocument, { name: 'create', from: 'new', to: 'draft', input: z.object({ strategy: z.enum(['direct', 'candidate']) }), handler: input => input });
const submit = command(TimedDocument, { name: 'submit', from: 'draft', to: 'reviewing', emits: [Submitted], handler: row => row });
const cancel = command(TimedDocument, { name: 'cancel', from: 'reviewing', to: 'cancelled', emits: [Cancelled], handler: row => row });
const accept = command(TimedDocument, { name: 'accept', from: 'reviewing', to: 'accepted', invokedBy: 'process', handler: row => row });
const reject = command(TimedDocument, { name: 'reject', from: 'reviewing', to: 'rejected', invokedBy: 'process', handler: row => row });
/** 申请人和策略进入提交快照；read 权限不代替 requesterField 的操作归属。 */
const review = approval(TimedDocument, { process: 'timed-document', start: Submitted, cancelOn: [Cancelled], routable: ['createdBy', 'strategy'], onApproved: accept, onRejected: reject });
/** 六秒总时限、提前5.4秒提醒；独立节点依旧按真实自然时间运行。 */
const policy = { sla: { durationMinutes: 0.1, remindBeforeMinutes: 0.09 }, actions: { transfer: true, delegate: true, addSign: true } } as const;
const reviewRoute = route('timed-document', [
  when(eq('strategy', 'direct'), step('限时部门审核', approver.role('timed_direct'), policy)),
  when(eq('strategy', 'candidate'), step('限时共享受理', approver.role('timed_candidates'), { ...policy, assignment: 'candidate' })),
], { reminders: { requesterField: 'createdBy', cooldownMinutes: 1 } });
/** 运行时独立导出；不改变 ROUTE 品牌，也不在业务声明里实现提醒逻辑。 */
const approvalOps = approvalOperations();
const domain = { ...org, TimedDocument, Submitted, Cancelled, create, submit, cancel, accept, reject, review, reviewRoute, approvalOps };
const reviewerCaps = ['TimedDocument.read', 'TimedDocument.accept', 'TimedDocument.reject'];
let env: TestEnv, server: CageServer, buyer: TestUser, first: TestUser, second: TestUser;
let operations: ReturnType<typeof approvalOperationsService>, engine: ReturnType<typeof reviewRoute.engine>;

/** 两个独立 kernel 共享同一隔离数据库，用来验证真实多 worker 的持久去重。 */
beforeAll(async () => {
  env = await createTestEnv({ domain }); operations = approvalOperationsService(env.kernel); engine = reviewRoute.engine(env.kernel);
  buyer = await env.user({ caps: ['TimedDocument.read', 'TimedDocument.create', 'TimedDocument.submit', 'TimedDocument.cancel'], scopes: { TimedDocument: 'self' } });
  first = await reviewer(); second = await reviewer();
  const direct = await env.kernel.execute('Role.create', { code: 'timed_direct', name: '时限直接办理人' }, env.system());
  const candidates = await env.kernel.execute('Role.create', { code: 'timed_candidates', name: '时限候选办理人' }, env.system());
  await env.kernel.execute('User.assignRoles', { id: first.id, roleIds: [first.roleId, direct.id, candidates.id] }, env.system());
  await env.kernel.execute('User.assignRoles', { id: second.id, roleIds: [second.roleId, candidates.id] }, env.system());
  server = createServer({ domain, urls: env.urls, logger: false, admin: false, authRateLimitPerMinute: 1000 }); await server.ready();
});
/** 服务器连接先退出，再回收临时数据库；没有测试进程独立启动的常驻调度器。 */
afterAll(async () => { await server?.close(); await env?.close(); });

/** 独立角色方便在单例里撤权，不污染其他测试的办理人权限。 */
async function reviewer() { return env.user({ caps: reviewerCaps, scopes: { TimedDocument: 'all' } }); }
/** 从真实领域命令启动新轮次，并取得可追溯的实例和业务对象 ID。 */
async function launch(strategy: 'direct' | 'candidate' = 'direct') {
  const subject = await env.kernel.execute('TimedDocument.create', { strategy }, await buyer.ctx());
  await env.kernel.execute('TimedDocument.submit', { id: subject.id }, await buyer.ctx()); await env.drain();
  const instance = (await operations.requests(await buyer.ctx())).find(item => item.businessKey === subject.id);
  expect(instance).toBeDefined(); return { id: subject.id as string, instance: instance! };
}
/** 公开提醒分页中的当前业务对象子集，不能靠直接读通知表绕过权限作为成功证据。 */
async function notices(user: TestUser, businessKey: string) {
  return (await operations.notices(await user.ctx(), { limit: 200 })).items.filter(item => item.businessKey === businessKey);
}
/** 自然时间等待同一节点的提醒；重复 tick 模拟重启与多进程轮询，数据库负责去重。 */
async function waitNotice(user: TestUser, businessKey: string, kind: 'due_soon' | 'overdue' | 'urge') {
  let found: Awaited<ReturnType<typeof notices>>[number] | undefined;
  await expect.poll(async () => {
    await Promise.all([operations.tick(), approvalOperationsService(server.kernel).tick()]);
    found = (await notices(user, businessKey)).find(item => item.kind === kind); return !!found;
  }, { interval: 150, timeout: 12_000 }).toBe(true);
  return found!;
}
/** 真实 Cookie/CSRF 账号会话，凭据只在测试内存使用，不输出到断言报告。 */
async function actorHttp(user: TestUser) {
  const password = `Deadline!${randomUUID()}`;
  await env.kernel.execute('User.setPassword', { id: user.id, password }, env.system());
  const jar = new Map<string, string>();
  const remember = (response: { cookies: { name: string; value: string }[] }) => response.cookies.forEach(cookie => jar.set(cookie.name, cookie.value));
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const csrf = await server.app.inject({ method: 'GET', url: '/auth/csrf' }); remember(csrf);
  const login = await server.app.inject({ method: 'POST', url: '/auth/login', payload: { username: user.username, password }, headers: { cookie: cookie(), 'x-csrf-token': csrf.json().token } });
  expect(login.statusCode).toBe(200); remember(login);
  const renewed = await server.app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: cookie() } }); remember(renewed);
  return {
    get: (url: string) => server.app.inject({ method: 'GET', url, headers: { cookie: cookie() } }),
    post: (url: string, payload: object) => server.app.inject({ method: 'POST', url, payload, headers: { cookie: cookie(), 'x-csrf-token': renewed.json().token } }),
  };
}

describe('框架声明、催办与持久提醒', () => {
  it('无运行时拒绝开启政策，无流程的单独运行时可安全启动', async () => {
    const { approvalOps: _runtime, ...withoutRuntime } = domain;
    expect(() => buildRegistry(withoutRuntime)).toThrow('CAGE-APPR-006');
    for (const durationMinutes of [0, -1, Infinity, NaN]) expect(() => step('错误时限', approver.role('reviewer'), { sla: { durationMinutes } })).toThrow();
    const empty = await createTestEnv({ domain: { ...org, operations: approvalOperations() } });
    try { const service = approvalOperationsService(empty.kernel); await service.ready(); expect(await service.tick()).toBe(0); }
    finally { await empty.close(); }
  });

  it('节点截止持久保存，催办并发仅一次成功且不改变业务或任务版本', async () => {
    const item = await launch();
    const task = (await engine.tasksOf(first.id, env.tenantId)).find(t => t.businessKey === item.id)!;
    expect(task.dueAt).toBe(item.instance.dueAt);
    const before = await env.kernel.read.get(TimedDocument, item.id, await buyer.ctx());
    const ctx = await buyer.ctx();
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => operations.urge(item.instance.id, ctx, { expectedStep: 0, reason: '请及时核查' })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await notices(first, item.id)).filter(n => n.kind === 'urge')).toHaveLength(1);
    expect((await env.kernel.read.get(TimedDocument, item.id, await buyer.ctx())).version).toBe(before.version);
    expect((await engine.tasksOf(first.id, env.tenantId)).find(t => t.id === task.id)?.revision).toBe(task.revision);
    const next = (await operations.requests(await buyer.ctx())).find(request => request.id === item.instance.id)!;
    expect(Date.parse(next.nextUrgeAt!)).toBeGreaterThan(Date.now());
  });

  it('缺失或非法申请人快照在取消旧轮次前拒绝，不产生无人可催办实例', async () => {
    const item = await launch();
    const original = (await engine.tasksOf(first.id, env.tenantId)).find(task => task.businessKey === item.id)!;
    for (const value of [undefined, null, '不是用户UUID', 123, [buyer.id]]) {
      // 在同一个调用事务内捕获公开输入错误并提交，用数据库结果证明校验发生在取消旧轮次之前，而不只依赖外层回滚掩盖顺序错误。
      // 这是消费端收到坏快照的边界，正常业务路径仍由上面的领域提交创建实际旧轮次。
      const failure = await env.kernel.app.transaction().execute(async tx => {
        try {
          await engine.start({ process: reviewRoute.process, tenantId: env.tenantId, businessKey: item.id, tx,
            vars: { strategy: 'direct', ...(value === undefined ? {} : { createdBy: value }) } });
          return null;
        } catch (error) { return error; }
      });
      expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
      expect(await env.query('select id, status from flow.approval_instance where business_key=$1', [item.id]))
        .toEqual([{ id: item.instance.id, status: 'running' }]);
      expect((await engine.tasksOf(first.id, env.tenantId)).find(task => task.id === original.id))
        .toMatchObject({ status: 'pending', revision: original.revision, dueAt: original.dueAt });
      expect((await engine.taskHistory('TimedDocument', item.id, await buyer.ctx())).items.some(action => action.action === 'cancelled')).toBe(false);
    }
  });

  it('可读取单据的审批人也不能冒用申请人，旧节点和非法原因拒绝', async () => {
    const item = await launch();
    await expect(operations.urge(item.instance.id, await first.ctx(), { expectedStep: 0, reason: '冒用申请人' })).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    await expect(operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 9, reason: '旧页面步骤' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: ' ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await notices(first, item.id)).some(n => n.kind === 'urge')).toBe(false);
  });

  it('自然时间产生临期和超时，多worker与新服务实例不重复投递且已读幂等', async () => {
    const item = await launch();
    const soon = await waitNotice(first, item.id, 'due_soon');
    const read = await operations.readNotice(soon.id, await first.ctx());
    expect(await operations.readNotice(soon.id, await first.ctx())).toEqual(read);
    expect((await operations.notices(await first.ctx(), { unreadOnly: true, limit: 200 })).items.some(n => n.id === soon.id)).toBe(false);
    await waitNotice(first, item.id, 'overdue');
    for (let index = 0; index < 3; index++) await Promise.all([operations.tick(), approvalOperationsService(server.kernel).tick()]);
    expect((await notices(first, item.id)).filter(n => n.kind === 'due_soon')).toHaveLength(1);
    expect((await notices(first, item.id)).filter(n => n.kind === 'overdue')).toHaveLength(1);
    await expect(operations.readNotice(soon.id, await second.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('worker停机跨过截止只补超时，不补发已经过期的临期阶段', async () => {
    const item = await launch();
    // launch 的 drain 仅完成提交 outbox；此后只等真实时间，不推进任何 runtime，也不修改数据库时限。
    expect(await notices(first, item.id)).toEqual([]);
    await expect.poll(() => Date.now() > Date.parse(item.instance.dueAt!), { interval: 100, timeout: 12_000 }).toBe(true);
    expect(await notices(first, item.id)).toEqual([]);
    const resumed = approvalOperationsService(server.kernel);
    await resumed.ready(); await resumed.tick();
    const restored = (await resumed.notices(await first.ctx(), { limit: 200 })).items.filter(row => row.businessKey === item.id);
    expect(restored.map(row => row.kind)).toEqual(['overdue']);
    expect((await engine.tasksOf(first.id, env.tenantId)).find(task => task.businessKey === item.id)?.dueAt).toBe(item.instance.dueAt);
    expect((await env.kernel.read.get(TimedDocument, item.id, await buyer.ctx())).status).toBe('reviewing');
  });

  it('当前接收授权过滤成空页仍能继续游标，另一kernel保留分页及本人已读', async () => {
    // 独立收件人没有前例通知，两个业务实例保证游标前后关系；转出首票只改变当前接收资格，不删除通知。
    const recipient = await reviewer(), firstItem = await launch(), secondItem = await launch();
    for (const item of [firstItem, secondItem]) {
      const task = (await engine.tasksOf(first.id, env.tenantId)).find(row => row.businessKey === item.id)!;
      await engine.act(task.id, first.id, env.tenantId, { action: 'transfer', targetUserId: recipient.id, expectedRevision: task.revision, reason: '分页收件人接收' });
      await operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '验证分页持久游标' });
    }
    const original = await operations.notices(await recipient.ctx(), { limit: 1 });
    expect(original.items).toHaveLength(1); expect(original.items[0].businessKey).toBe(firstItem.id);
    expect(original.nextCursor).toBe(original.items[0].id);
    const transferred = (await engine.tasksOf(recipient.id, env.tenantId)).find(row => row.businessKey === firstItem.id)!;
    await engine.act(transferred.id, recipient.id, env.tenantId, { action: 'transfer', targetUserId: second.id, expectedRevision: transferred.revision, reason: '首条接收资格已转出' });
    const otherKernel = approvalOperationsService(server.kernel), ctx = await recipient.ctx();
    const empty = await otherKernel.notices(ctx, { limit: 1 });
    expect(empty.items).toEqual([]); expect(empty.nextCursor).toBe(original.nextCursor);
    const next = await otherKernel.notices(ctx, { after: empty.nextCursor!, limit: 1 });
    expect(next.items).toHaveLength(1); expect(next.items[0].businessKey).toBe(secondItem.id); expect(next.nextCursor).toBeNull();
    const read = await otherKernel.readNotice(next.items[0].id, ctx);
    expect(await operations.readNotice(next.items[0].id, ctx)).toEqual(read);
    expect((await operations.notices(ctx, { after: empty.nextCursor!, limit: 1 })).items[0].readAt).toBe(read.readAt);
    expect(await otherKernel.notices(ctx, { after: empty.nextCursor!, limit: 1, unreadOnly: true })).toEqual({ items: [], nextCursor: null });
  });

  it('候选已完成前签后不再收到共享原票提醒，也不能重新认领第二票', async () => {
    const item = await launch('candidate');
    const task = (await engine.candidateTasks(first.id, env.tenantId)).find(row => row.businessKey === item.id)!;
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: task.revision, reason: '原候选负责办理' });
    await engine.act(task.id, first.id, env.tenantId, { action: 'addSign', placement: 'before', userIds: [second.id], expectedRevision: task.revision + 1, reason: '先取得第二位候选的专业意见' });
    const child = (await engine.tasksOf(second.id, env.tenantId)).find(row => row.businessKey === item.id)!;
    await engine.decide(child.id, second.id, env.tenantId, 'approved', '专业意见完成', child.revision);
    const resumed = (await engine.tasksOf(first.id, env.tenantId)).find(row => row.id === task.id)!;
    await engine.act(task.id, first.id, env.tenantId, { action: 'unclaim', expectedRevision: resumed.revision, reason: '归还共享受理票' });
    expect((await operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '独立审批人数不能压缩' })).recipientCount).toBe(1);
    expect((await notices(first, item.id)).filter(row => row.kind === 'urge')).toHaveLength(1);
    expect(await notices(second, item.id)).toEqual([]);
    expect((await engine.candidateTasks(second.id, env.tenantId)).some(row => row.id === task.id)).toBe(false);
    const available = (await engine.candidateTasks(first.id, env.tenantId)).find(row => row.id === task.id)!;
    await expect(engine.act(task.id, second.id, env.tenantId, { action: 'claim', expectedRevision: available.revision, reason: '不能承担同节点第二票' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('转办后原收件人失去通知可见性，新办理人补发且截止不重置', async () => {
    const item = await launch(), note = await waitNotice(first, item.id, 'overdue');
    const task = (await engine.tasksOf(first.id, env.tenantId)).find(t => t.businessKey === item.id)!;
    await engine.act(task.id, first.id, env.tenantId, { action: 'transfer', targetUserId: second.id, expectedRevision: task.revision, reason: '专业交接' });
    expect((await notices(first, item.id))).toEqual([]);
    await expect(operations.readNotice(note.id, await first.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await engine.tasksOf(second.id, env.tenantId)).find(t => t.id === task.id)?.dueAt).toBe(task.dueAt);
    await waitNotice(second, item.id, 'overdue');
  });

  it('后签等待期不提醒，激活时沿用节点时限；委派提醒包含原责任人', async () => {
    const item = await launch();
    let task = (await engine.tasksOf(first.id, env.tenantId)).find(t => t.businessKey === item.id)!;
    await engine.act(task.id, first.id, env.tenantId, { action: 'addSign', placement: 'after', userIds: [second.id], expectedRevision: task.revision, reason: '后置复核' });
    await operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '核查当前办理票' });
    expect(await notices(second, item.id)).toEqual([]);
    task = (await engine.tasksOf(first.id, env.tenantId)).find(t => t.id === task.id)!;
    await engine.decide(task.id, first.id, env.tenantId, 'approved', '进入后签', task.revision);
    const after = (await engine.tasksOf(second.id, env.tenantId)).find(t => t.businessKey === item.id)!;
    expect(after.dueAt).toBe(task.dueAt);
    await waitNotice(second, item.id, 'overdue');
    const delegated = await launch();
    const original = (await engine.tasksOf(first.id, env.tenantId)).find(t => t.businessKey === delegated.id)!;
    await engine.act(original.id, first.id, env.tenantId, { action: 'delegate', targetUserId: second.id, expectedRevision: original.revision, reason: '协助核查' });
    const receipt = await operations.urge(delegated.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '请协同处理' });
    expect(receipt.recipientCount).toBe(2);
    expect((await notices(first, delegated.id)).some(n => n.kind === 'urge')).toBe(true);
    expect((await notices(second, delegated.id)).some(n => n.kind === 'urge')).toBe(true);
  });

  it('未领取候选按当前资格通知，领取后其他候选看不到旧催办原因', async () => {
    const item = await launch('candidate');
    expect((await operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '共享受理事项' })).recipientCount).toBe(2);
    const otherNotice = (await notices(second, item.id))[0]; expect(otherNotice).toBeDefined();
    const task = (await engine.candidateTasks(first.id, env.tenantId)).find(t => t.businessKey === item.id)!;
    await engine.act(task.id, first.id, env.tenantId, { action: 'claim', expectedRevision: task.revision, reason: '由我办理' });
    expect(await notices(second, item.id)).toEqual([]);
    await expect(operations.readNotice(otherNotice.id, await second.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('无接收人时催办失败不占冷却，撤权后不能读取已收到的原因', async () => {
    const item = await launch(), recipient = await reviewer();
    const task = (await engine.tasksOf(first.id, env.tenantId)).find(t => t.businessKey === item.id)!;
    await engine.act(task.id, first.id, env.tenantId, { action: 'transfer', targetUserId: recipient.id, expectedRevision: task.revision, reason: '权限验证独立办理人' });
    await env.kernel.execute('Role.revokeCapability', { id: recipient.roleId, capability: 'TimedDocument.read' }, env.system());
    await expect(operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '无可读办理人' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await operations.requests(await buyer.ctx())).find(row => row.id === item.instance.id)?.nextUrgeAt).toBeNull();
    await env.kernel.execute('Role.grantCapability', { id: recipient.roleId, capability: 'TimedDocument.read' }, env.system());
    await operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '恢复授权后重试' });
    const note = (await notices(recipient, item.id))[0]; expect(note).toBeDefined();
    await env.kernel.execute('Role.revokeCapability', { id: recipient.roleId, capability: 'TimedDocument.read' }, env.system());
    expect(await notices(recipient, item.id)).toEqual([]);
    await expect(operations.readNotice(note.id, await recipient.ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('取消事件尚未消费也拒绝旧版本催办，结束实例不产生晚到提醒', async () => {
    const item = await launch();
    await env.kernel.execute('TimedDocument.cancel', { id: item.id }, await buyer.ctx());
    await expect(operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '过期业务版本' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await env.drain();
    const completed = await launch();
    const task = (await engine.tasksOf(first.id, env.tenantId)).find(t => t.businessKey === completed.id)!;
    await engine.decide(task.id, first.id, env.tenantId, 'approved', '正常完成', task.revision);
    await operations.tick();
    expect((await operations.requests(await buyer.ctx())).some(row => [item.instance.id, completed.instance.id].includes(row.id))).toBe(false);
    expect(await env.query('select id from flow.approval_notice where instance_id = any($1::uuid[])', [[item.instance.id, completed.instance.id]])).toEqual([]);
  });

  it('通知插入失败时催办、冷却和动作历史一并回滚', async () => {
    const item = await launch();
    await env.query(`create function flow.fail_deadline_notice() returns trigger language plpgsql as $$ begin if NEW.reason = 'ROLLBACK_PROBE' then raise exception 'deadline notice probe'; end if; return NEW; end $$;
      create trigger deadline_notice_probe before insert on flow.approval_notice for each row execute function flow.fail_deadline_notice();`);
    try {
      await expect(operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: 'ROLLBACK_PROBE' })).rejects.toThrow();
      expect((await operations.requests(await buyer.ctx())).find(row => row.id === item.instance.id)?.nextUrgeAt).toBeNull();
      expect((await engine.taskHistory('TimedDocument', item.id, await buyer.ctx())).items.some(row => row.action === 'urged')).toBe(false);
    } finally { await env.query('drop trigger deadline_notice_probe on flow.approval_notice; drop function flow.fail_deadline_notice();'); }
    expect((await operations.urge(item.instance.id, await buyer.ctx(), { expectedStep: 0, reason: '失败后正常重试' })).recipientCount).toBe(1);
  });

  it('真实会话、CSRF与严格输入贯穿催办、提醒、已读和OpenAPI', async () => {
    const item = await launch(), requester = await actorHttp(buyer), recipient = await actorHttp(first);
    expect((await requester.post(`/api/approval/instances/${item.instance.id}/urge`, { expectedStep: 0, reason: 'HTTP催办', recipientId: second.id })).statusCode).toBe(400);
    expect((await requester.post(`/api/approval/instances/${item.instance.id}/urge`, { expectedStep: 0, reason: 'HTTP催办' })).statusCode).toBe(200);
    const response = await recipient.get('/api/approval/notices?unreadOnly=false');
    expect(response.statusCode).toBe(200);
    const notice = response.json().items.find((row: { businessKey: string; kind: string }) => row.businessKey === item.id && row.kind === 'urge');
    expect(notice).toBeDefined();
    expect((await recipient.post(`/api/approval/notices/${notice.id}/read`, {})).statusCode).toBe(200);
    expect((await recipient.get('/api/approval/notices?after=9223372036854775808')).statusCode).toBe(400);
    const missingCsrf = await server.app.inject({ method: 'POST', url: `/api/approval/notices/${notice.id}/read`, payload: {} });
    expect(missingCsrf.statusCode).toBeGreaterThanOrEqual(400);
    const openapi = await requester.get('/api/openapi.json');
    expect(openapi.json().paths['/api/approval/instances/{id}/urge']).toBeDefined();
  });
});
