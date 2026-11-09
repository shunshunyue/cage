/**
 * 跨 HTTP、浏览器 SDK 和后端运行时的 AI 协议入口；仅依赖 Zod，不导入数据库或 React。
 * 严格 schema 拒绝额外字段并限制内容规模；页面快照是客户端定位信息，服务端仍须重读业务事实和核对授权。
 */
// 协议独立于数据库、React 和模型实现，同一 schema 同时约束 HTTP、SDK 与工具交互。
import { z } from 'zod';
export { modelKeySchema, modelConfigSchema, type AiModelConfig, type AiModelConfigInput, type AiModelProbe } from './models.js';
export * from './personalities.js';
import type { AiPersonalitySummary } from './personalities.js';

/** 通用声明/页面标识的长度边界；只是字符串格式校验，不能证明注册存在或主体有权访问。 */
const name = z.string().min(1).max(160);
/** 页面中对象的定位引用；observedVersion 是客户端曾看到的正版本，用于服务端重读后提示变化，不能代替事实读取。 */
const objectRef = z.object({ aggregate: name, id: z.uuid(), observedVersion: z.number().int().positive().optional() }).strict();
/**
 * 页面语义快照校验：pageInstanceId 区分标签页，revision 为零基修订号，capturedAt 为带时区 ISO 时间。
 * page 描述路由；subject/selection/view 只定位记录，observedVersion 用于提示变化。draft 是未保存命令输入，baseVersion 是编辑基准；visibleContent 只作不可信提示。
 * 集合与文字有规模上限，schema 通过不表示对象可读或命令可执行。
 */
export const pageContextSchema = z.object({
  pageInstanceId: z.string().min(1).max(160), revision: z.number().int().nonnegative(), capturedAt: z.iso.datetime({ offset: true }),
  page: z.object({ id: name, title: z.string().max(200), kind: z.enum(['list', 'detail', 'form', 'dashboard', 'custom']), route: z.string().max(1000) }).strict(),
  subject: objectRef.optional(),
  selection: z.object({ aggregate: name, ids: z.array(z.uuid()).max(100) }).strict().optional(),
  view: z.object({ aggregate: name.optional(), query: name.optional(), input: z.record(z.string(), z.unknown()).optional(),
    visibleIds: z.array(z.uuid()).max(100).optional(), visibleFields: z.array(name).max(80).optional() }).strict().optional(),
  draft: z.object({ command: name, values: z.record(z.string(), z.unknown()), baseVersion: z.number().int().positive().optional() }).strict().optional(),
  visibleContent: z.array(z.object({ id: name, text: z.string().max(4000) }).strict()).max(10).optional(),
}).strict();
/**
 * 通过页面 schema 校验的 SDK 快照类型；可选字段省略表示该页未提供对应语义。
 */
export type PageContext = z.infer<typeof pageContextSchema>;

/**
 * 发送消息输入，message 去除首尾空白且不能为空；pageContext 可选，额外字段拒绝。
 */
export const messageInputSchema = z.object({ message: z.string().trim().min(1).max(16_000), pageContext: pageContextSchema.optional() }).strict();
/**
 * 发送一轮消息的输入类型，和会话 ID、请求幂等键分开传递。
 */
export type AiMessageInput = z.infer<typeof messageInputSchema>;
/**
 * 审批三态裁决：pass 通过、return 退回修改、manual 转人工；reason 说明依据，suggestions 是修改建议。
 * evidence 的 source 必须在运行时对应已提供证据，detail 为引用解释；schema 本身不证明模型判断正确。
 */
export const aiDecisionSchema = z.object({
  decision: z.enum(['pass', 'return', 'manual']), reason: z.string().min(1).max(2000),
  suggestions: z.array(z.string().max(1000)).max(20).default([]),
  evidence: z.array(z.object({ source: name, detail: z.string().max(1000) }).strict()).max(30).default([]),
}).strict();
/**
 * 运行公开状态：queued/running 可继续执行，waiting_input/waiting_confirmation 等待用户，其余为终态。
 */
export const runStatusSchema = z.enum(['queued', 'running', 'waiting_input', 'waiting_confirmation', 'succeeded', 'failed', 'cancelled', 'expired']);
/**
 * 从运行状态 schema 派生的联合类型，避免 HTTP 与 SDK 独立维护枚举。
 */
export type AiRunStatus = z.infer<typeof runStatusSchema>;
/**
 * 当前用户可见的会话元数据，不包含聊天内容、授权或密钥。
 */
export interface AiSession { /** 会话 UUID，归属由服务端用户和租户限定。 */ id: string; /** 会话显示标题。 */ title: string; /** 创建时间 ISO 字符串。 */ createdAt: string; /** 最近活动时间 ISO 字符串。 */ updatedAt: string; /** 显式性格 key，null 表示跟随租户默认项。 */ personalityKey: string | null; /** 会话性格选择的乐观版本，区别于性格内容版本。 */ personalityVersion: number }
/**
 * 持久交互请求；用户提交唯一类型的答复后，后台重新领取任务继续执行。
 */
export interface AiInteraction { /** 互动 UUID，答复必须引用该标识。 */ id: string; /** input 为文字，confirmation 为确认，page_context 为原页面的新快照。 */ kind: 'input' | 'confirmation' | 'page_context'; /** 给用户的具体问题或确认提示。 */ prompt: string; /** 交互所需的可见预览，形状由 kind 决定。 */ data: unknown; /** 委托到期的 ISO 时间，过期答复不能恢复运行。 */ expiresAt: string }
/**
 * 面向客户端的运行快照；没有暴露原始权限、模型历史及租约，工具完成与最终回答分别展示。
 */
export interface AiRun {
  /**
   * 运行 UUID。
   */
  id: string; /** 所属助理会话，审批运行没有会话时为 null。 */ sessionId: string | null; /** 公开执行状态，202 返回时通常只是 queued。 */ status: AiRunStatus; /** 后端阶段标识，供进度显示而非调度决策。 */ phase: string; /** 最终回答；尚未形成时为 null。 */ answer: string | null; /** 失败码，成功或尚未失败为 null。 */ error: string | null;
  /**
   * 已记录的模型步数。
   */
  steps: number; /** 已观察工具结果数。 */ toolCalls: number; /** 累计结算 Token，可能包含保守估算。 */ tokens: number; /** 创建时间 ISO 字符串。 */ createdAt: string; /** 最后持久变更时间 ISO 字符串。 */ updatedAt: string; /** 尚待用户回复的交互，终态为空。 */ interactions: AiInteraction[];
  /**
   * 该轮使用的性格公开摘要，可省略。
   */
  personality?: AiPersonalitySummary;
}
/**
 * 持久 SSE 事件类型，文字/模型/工具/上下文与运行状态分开，事件不包含模型私有推理。
 */
export type AiEventType = 'run.status' | 'model.started' | 'model.completed' | 'model.failed' | 'message.delta' | 'message.completed' | 'tool.started' | 'tool.completed' | 'interaction.required' | 'context.updated';
/**
 * 可按 sequence 重放的单条事件，SDK 应先核对 runId 并去重。
 */
export interface AiEvent { /** 所属运行，跨运行事件不可合并。 */ runId: string; /** 运行内递增序号，续传使用最后已交付序号。 */ sequence: number; /** 决定 data 语义的事件种类。 */ type: AiEventType; /** 按事件种类解释的载荷，消费前需检查字段类型。 */ data: unknown; /** 事件入库时间 ISO 字符串。 */ createdAt: string }
/**
 * 交互答复只允许 approved、answer、pageContext 中一个；具体类型与原交互匹配由服务端核验。
 */
export const interactionResponseSchema = z.object({
  approved: z.boolean().optional(), answer: z.string().max(16000).optional(), pageContext: pageContextSchema.optional(),
}).strict().refine(value => [value.approved, value.answer, value.pageContext].filter(v => v !== undefined).length === 1, '只能提供一种交互答复');
/**
 * 批准/拒绝、补充文字或新页面快照的互斥答复。
 */
export type AiInteractionResponse = z.infer<typeof interactionResponseSchema>;
/**
 * 用户表达偏好的公开记录；不作为业务事实或授权来源。
 */
export interface AiMemory { /** 偏好 UUID，用于本人删除。 */ id: string; /** 偏好名称，同用户内唯一。 */ key: string; /** 偏好文字，不应存密钥或查询记录。 */ value: string; /** 最近更新 ISO 时间。 */ updatedAt: string }

/**
 * 有限只读查询计划；aggregate/字段/指标由运行时注册表白名单核验，输入不是 SQL。
 * where 为有限标量比较，groupBy 最多四字段，metrics 最多八项，as 为输出别名；limit 默认 50 且不超过 200，未返回行不能作为全集。
 */
export const queryPlanSchema = z.object({
  aggregate: name,
  select: z.array(name).max(40).optional(),
  where: z.array(z.object({ field: name, op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']), value: z.unknown() }).strict()).max(20).default([]),
  groupBy: z.array(name).max(4).default([]),
  metrics: z.array(z.object({ op: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: name.optional(), as: z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/) }).strict()).max(8).default([]),
  orderBy: z.object({ field: name, direction: z.enum(['asc', 'desc']) }).strict().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
/**
 * 通过 schema 的有限查询计划，仍需检查 read 能力、字段可用性和安全视图。
 */
export type QueryPlan = z.infer<typeof queryPlanSchema>;
