/**
 * 审批 HTTP 的 OpenAPI 描述，由 cage-http 在已装配代码内审批引擎时合并。
 * 输入结构从任务动作 schema 产生，描述不能代替服务端当前任务、权限和事务验证；不读取业务数据。
 */
import { z } from 'zod';
import { taskActionSchema } from './task-actions.js';
import { approvalUrgeSchema } from './operations-schema.js';

/** HTTP 决定输入与文档共用；旧节点可不带版本，新流转节点由引擎进一步要求 expectedRevision。 */
export const approvalDecisionSchema = z.strictObject({
  comment: z.string().max(1000).optional(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

/**
 * 生成待办、审批决定、流转动作和操作历史路径；全部复用宿主 Cookie/CSRF，不开放流程身份命令。
 * 文档中的 200 表示本次操作提交，finished:false 不代表整个审批完成；错误保留框架协议码。
 */
export function approvalOpenApi(options: { operations?: boolean } = {}): Record<string, Record<string, unknown>> {
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const responses = { 200: { description: '本次操作成功；审批结束与否查看 finished，任务操作返回 revision/createdTaskIds' },
    default: { description: '身份、能力、范围、任务状态、版本或领域约束拒绝', content: { 'application/json': { schema: { $ref: '#/components/schemas/CageError' } } } } };
  const paths: Record<string, Record<string, unknown>> = {
    '/api/approval/tasks': { get: { summary: '本人审批待办，含 revision/委派状态/节点政策', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', default: 'pending' } }], responses } },
    '/api/approval/candidate-tasks': { get: { summary: '当前有候选身份、批准权限和单据范围的未领取任务', description: '每流程从最近 200 项未领取任务中筛选；查询不占用任务，领取时再次验证。', responses } },
  };
  for (const action of taskActionSchema.options) {
    const name = action.shape.action.value;
    const path = name === 'addSign' ? 'add-sign' : name;
    const { action: _discriminator, ...body } = action.shape;
    paths[`/api/approval/tasks/{id}/${path}`] = { post: {
      summary: `审批任务 ${name}`, description: '节点须显式开放；任务归属、revision 与接收人权限由服务端重新核验。需会话和 CSRF。',
      parameters: [id], requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(z.strictObject(body)) } } }, responses,
    } };
  }
  for (const outcome of ['approve', 'reject', 'return']) paths[`/api/approval/tasks/{id}/${outcome}`] = { post: {
    summary: `审批决定 ${outcome}`, description: '候选领取或启用任务流转的节点必须提供 expectedRevision；waiting、未领取和受托未归还不能决定，最终结论走领域命令。',
    parameters: [id], requestBody: { content: { 'application/json': { schema: z.toJSONSchema(approvalDecisionSchema) } } }, responses,
  } };
  paths['/api/approval/task-history/{process}/{aggregate}/{id}'] = { get: {
    summary: '当前可读单据的人工任务操作历史', parameters: [id,
      ...['process', 'aggregate'].map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      { name: 'after', in: 'query', schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }],
    description: '按递增记录 ID 分页，nextCursor 为 null 表示当前末尾；校验单据 read/范围。', responses,
  } };
  if (options.operations) {
    paths['/api/approval/notices'] = { get: {
      summary: '本人当前授权可见的临期、超时和催办站内提醒',
      description: '返回 items 与 nextCursor；按当前单据权限及接收关系过滤，空页仍可能有下一页。自然分钟时限不替代审批决定。',
      parameters: [
        { name: 'after', in: 'query', schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        { name: 'unreadOnly', in: 'query', schema: { type: 'boolean', default: false } },
      ], responses,
    } };
    paths['/api/approval/notices/{id}/read'] = { post: {
      summary: '标记本人可见提醒已读', description: '重复调用保留首次已读时间；读取或接收权限失效时不可操作。需会话和 CSRF。',
      parameters: [{ ...id, schema: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } } }, responses,
    } };
    paths['/api/approval/requests'] = { get: {
      summary: '本人发起且显式开放催办的运行实例', description: '返回 currentSteps、各分支 activeSteps、最近截止 dueAt 与 nextUrgeAt；currentStep 仅为最小活跃索引。身份来自提交时的 requesterField 快照，仍需当前单据 read/范围。', responses,
    } };
    paths['/api/approval/instances/{id}/urge'] = { post: {
      summary: '申请人催办当前流程节点', description: '锁定实例复核申请人、节点和业务版本；并行实例必须提交 expectedSteps 完整活跃集合，冷却按实例持久共享。recipientCount 为任务与接收人配对数。无合格接收人明确失败，仅生成站内提醒。',
      parameters: [id], requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(approvalUrgeSchema) } } }, responses,
    } };
  }
  return paths;
}
