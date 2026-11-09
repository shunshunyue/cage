/**
 * 审批 SDK 与公开 HTTP 契约的回归：确认任务版本、动作路由和原因原样进入协议，并核对 OpenAPI 的严格输入。
 * 网络由 fetch 桩替代，仅验证浏览器侧边界；真实权限、并发、回滚由 testkit 的 PostgreSQL 用例验证。
 */
import { expect, it } from 'vitest';
import { CageClient } from '../../client/src/index.js';
import { approvalOpenApi } from '../../approval/src/openapi.js';
import { step, approver } from '../../approval/src/route.js';
import { approvalNoticeQuerySchema, approvalUrgeSchema } from '../../approval/src/operations-schema.js';

/** 待办操作后重新读取版本，决定请求不能丢失版本或把 action 字段混入严格请求体。 */
it('approval SDK preserves task revisions and uses the HTTP action and history protocols', async () => {
  const requests: { url: string; body: any }[] = [];
  const client = new CageClient({ fetch: (async (url, options) => {
    if (String(url).endsWith('/auth/csrf')) return new Response(JSON.stringify({ token: 'test-csrf' }));
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
    return new Response(JSON.stringify({ code: 'CONFLICT' }), { status: 409 });
  }) as typeof fetch });
  expect(await client.approvalTaskAction('task/id', { action: 'addSign', userIds: ['recipient'], expectedRevision: 7, reason: '请核对' }))
    .toMatchObject({ ok: false, code: 'CONFLICT' });
  await client.decideApprovalTask('task/id', 'approve', { expectedRevision: 8, comment: '同意' });
  await client.approvalTaskHistory('process/name', 'Document', 'object/id', { after: '9007199254740993', limit: 20 });
  expect(requests[0]).toEqual({ url: '/api/approval/tasks/task%2Fid/add-sign', body: { userIds: ['recipient'], expectedRevision: 7, reason: '请核对' } });
  expect(requests[1]).toEqual({ url: '/api/approval/tasks/task%2Fid/approve', body: { expectedRevision: 8, comment: '同意' } });
  expect(requests[2].url).toContain('/api/approval/task-history/process%2Fname/Document/object%2Fid?after=9007199254740993&limit=20');
  expect(requests).toHaveLength(3);
  await client.approvalCandidateTasks();
  await client.approvalTaskAction('pool', { action: 'claim', expectedRevision: 0, reason: '领取核查' });
  await client.approvalTaskAction('pool', { action: 'unclaim', expectedRevision: 1, reason: '交回候选池' });
  await client.approvalTaskAction('parent', { action: 'addSign', expectedRevision: 2, reason: '后签复核', userIds: ['recipient'], placement: 'after' });
  expect(requests.slice(3)).toEqual([
    { url: '/api/approval/candidate-tasks', body: null },
    { url: '/api/approval/tasks/pool/claim', body: { expectedRevision: 0, reason: '领取核查' } },
    { url: '/api/approval/tasks/pool/unclaim', body: { expectedRevision: 1, reason: '交回候选池' } },
    { url: '/api/approval/tasks/parent/add-sign', body: { expectedRevision: 2, reason: '后签复核', userIds: ['recipient'], placement: 'after' } },
  ]);
});

/** 不把协议描述当授权：文档必须声明版本与接收人，且不允许客户端指定任务种类或动作。 */
it('OpenAPI requires version and reason and excludes the action discriminator from request bodies', () => {
  const paths: any = approvalOpenApi();
  const transfer = paths['/api/approval/tasks/{id}/transfer'].post.requestBody.content['application/json'].schema;
  expect(transfer.required).toEqual(expect.arrayContaining(['expectedRevision', 'targetUserId', 'reason']));
  expect(transfer.additionalProperties).toBe(false);
  expect(transfer.properties.action).toBeUndefined();
  const signing = paths['/api/approval/tasks/{id}/add-sign'].post.requestBody.content['application/json'].schema;
  expect(signing.properties.userIds.maxItems).toBe(20);
  expect(signing.properties.placement.enum).toEqual(['parallel', 'before', 'after']);
  const claim = paths['/api/approval/tasks/{id}/claim'].post.requestBody.content['application/json'].schema;
  expect(claim.required).toEqual(expect.arrayContaining(['expectedRevision', 'reason']));
  expect(paths['/api/approval/candidate-tasks'].get).toBeDefined();
});

/** 节点政策复制成只读声明，调用方后来修改输入对象不能意外开放已定义的流程。 */
it('task policies are opt-in, copied and reject unknown runtime options', () => {
  const actions = { transfer: false };
  const defined = step('审核', approver.role('reviewer'), { actions });
  actions.transfer = true;
  expect(defined.actions?.transfer).toBe(false);
  expect(step('旧流程', approver.role('reviewer')).actions).toBeUndefined();
  expect(() => step('错误配置', approver.role('reviewer'), { actions: { arbitrary: true } as any })).toThrow('CAGE-APPR-006');
});

/** URL 保留实例和 bigint 游标；运营写入只传用户意图，不接受客户端伪造收件人或冷却。 */
it('approval operations SDK encodes instance IDs, bigint cursors and explicit unread filters', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const client = new CageClient({ fetch: (async (url, options) => {
    if (String(url).endsWith('/auth/csrf')) return new Response(JSON.stringify({ token: 'test-csrf' }));
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
    return new Response(JSON.stringify({ code: 'RATE_LIMITED' }), { status: 429 });
  }) as typeof fetch });
  await client.approvalRequests();
  await client.approvalNotices({ after: '9007199254740993', limit: 20, unreadOnly: false });
  await client.readApprovalNotice('9007199254740993');
  expect(await client.urgeApproval('instance/id', { expectedStep: 2, reason: '需要及时核对' })).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  expect(requests).toEqual([
    { url: '/api/approval/requests', body: null },
    { url: '/api/approval/notices?after=9007199254740993&limit=20&unreadOnly=false', body: null },
    { url: '/api/approval/notices/9007199254740993/read', body: {} },
    { url: '/api/approval/instances/instance%2Fid/urge', body: { expectedStep: 2, reason: '需要及时核对' } },
  ]);
});

/** 文档仅在运行时启用后出现；HTTP false 不得被通用布尔强制转换误判为 true。 */
it('operations HTTP schemas reject forged recipients and OpenAPI respects explicit runtime enablement', () => {
  expect(approvalNoticeQuerySchema.parse({ unreadOnly: 'false' })).toEqual({ unreadOnly: false });
  expect(approvalNoticeQuerySchema.safeParse({ unreadOnly: 'yes' }).success).toBe(false);
  expect(approvalUrgeSchema.safeParse({ expectedStep: 0, reason: '  ' }).success).toBe(false);
  expect(approvalUrgeSchema.safeParse({ expectedStep: 0, reason: '催办', recipientId: 'someone' }).success).toBe(false);
  expect(approvalOpenApi()['/api/approval/requests']).toBeUndefined();
  const paths: any = approvalOpenApi({ operations: true });
  const input = paths['/api/approval/instances/{id}/urge'].post.requestBody.content['application/json'].schema;
  expect(input.required).toEqual(['expectedStep', 'reason']);
  expect(input.additionalProperties).toBe(false);
  expect(paths['/api/approval/notices/{id}/read'].post.parameters[0].schema.type).toBe('string');
});
