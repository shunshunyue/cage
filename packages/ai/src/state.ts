/**
 * AI 运行记录与恢复状态的数据库映射；store/runtime 使用，前端 DTO 另在 ai-protocol。
 * 远端游标、调用预留、尝试次数与已结算消耗分别持久化，进程恢复时不能把未知调用当作未发生。
 */
import type { AiStep } from '@yss123/cage-approval';
import type { AiPersonality, AiRunStatus, PageContext } from '@yss123/cage-ai-protocol';
import type { ModelMessage, RunLimits, ToolCall } from './types.js';

/** 远端游标只描述可接续的历史；协议兼容性单独保存，不能随游标重建而丢失。 */
export interface RemoteHistory {
  /**
   * 模型配置指纹。
   */
  key: string;
  /**
   * 上游响应 ID，不接受浏览器指定。
   */
  responseId: string;
  /**
   * 远端已包含的本地消息数量。
   */
  historyLength: number;
  /**
   * 远端链已占用的估算 Token，接续并非免费上下文。
   */
  contextTokens: number;
}

/**
 * 模型请求前写入的费用预留，结果未知时保守结算，明确拒绝接续时释放。
 */
export interface ModelReservation {
  /**
   * 调用尝试的一基编号。
   */
  attempt: number;
  /**
   * 成功后计入的模型步数。
   */
  step: number;
  /**
   * 本次输入预留 Token。
   */
  inputTokens: number;
  /**
   * 本次最大输出预留 Token。
   */
  outputTokens: number;
  /**
   * 预留开始的 ISO 时间。
   */
  startedAt: string;
}

/**
 * 本次请求冻结的工具装载模式与预算，发现工具复用同一规则。
 */
export interface ToolPlan {
  /**
   * all 为全部工具，discovery 为有界候选及发现入口。
   */
  mode: 'all' | 'discovery';
  /**
   * 完整工具 schema 的估算 Token 上限。
   */
  tokenBudget: number;
  /**
   * 包含通用工具的总数量上限。
   */
  maxTools: number;
}

/**
 * 两类运行的公共数据库字段，状态以数据库为准，执行者持有有期租约。
 */
interface RunRecord {
  /**
   * 运行 UUID，也是请求关联键。
   */
  id: string;
  /**
   * 所属租户，跨记录读取必须一致。
   */
  tenant_id: string;
  /**
   * 排队、执行、交互或终态。
   */
  status: AiRunStatus;
  /**
   * 下一阶段：准备上下文、模型、动作或结束。
   */
  phase: 'context' | 'model' | 'actions' | 'done';
  /**
   * 本轮用户任务文字。
   */
  input: string;
  /**
   * 客户端页面定位/草稿；null 表示未提供，不是可信事实。
   */
  page_context: PageContext | null;
  /**
   * 服务端读取的事实与偏好；未准备时为 null。
   */
  context: Record<string, unknown> | null;
  /**
   * 含调用/回执配对的持久历史。
   */
  history: ModelMessage[];
  /**
   * 本轮消息开始索引，避免重复复制旧轮次。
   */
  history_start: number;
  /**
   * 自动历史窗口已省略更早内容的标记。
   */
  history_omitted: boolean;
  /**
   * 已规划尚待串行消费的工具调用。
   */
  pending: ToolCall[];
  /**
   * 稳定模型声明别名。
   */
  model: string;
  /**
   * 提交时冻结的应用或审批指令。
   */
  instructions: string;
  /**
   * 提交时冻结的执行额度。
   */
  limits: RunLimits;
  /**
   * 助理性格快照，审批为 null。
   */
  personality: AiPersonality | null;
  /**
   * 注册声明指纹，变化后拒绝旧结果。
   */
  fingerprint: string;
  /**
   * 上下文准备时的授权指纹，尚未建立时为 null。
   */
  auth_fingerprint: string | null;
  /**
   * 发起任务的登录会话，恢复时复核有效性。
   */
  auth_session: string | null;
  /**
   * 委托到期时间，等待用户也受此限制。
   */
  delegated_until: Date;
  /**
   * 二次认证时间戳，null 表示无证据。
   */
  step_up_at: number | null;
  /**
   * 已结算有效模型步数。
   */
  steps: number;
  /**
   * 已结算累计 Token，不含在途预留。
   */
  tokens: number;
  /**
   * 已进入历史观察结果的工具次数。
   */
  tool_calls: number;
  /**
   * 本次已加载业务工具 key，未规划为 null。
   */
  tool_keys: string[] | null;
  /**
   * 冻结的装载模式与预算。
   */
  tool_plan: ToolPlan | null;
  /**
   * 有效远端接续游标，无可用游标时为 null。
   */
  model_state: RemoteHistory | null;
  /**
   * 已确认不支持接续的配置指纹。
   */
  continuation_disabled_key: string | null;
  /**
   * 总调用尝试数，包含未成功回答的尝试。
   */
  model_attempts: number;
  /**
   * 在途未结算调用，恢复时保守记账。
   */
  model_reservation: ModelReservation | null;
  /**
   * 执行者令牌，释放后为 null。
   */
  lease_token: string | null;
  /**
   * 租约截止，超时可由其他执行者领取。
   */
  lease_until: Date | null;
  /**
   * 执行截止时间，回复交互重新排队时清空。
   */
  deadline: Date | null;
  /**
   * 取消标记，阻止迟到事务提交。
   */
  cancelled: boolean;
  /**
   * 最终文字或裁决 JSON，未完成为 null。
   */
  answer: string | null;
  /**
   * 稳定失败码，不保存上游正文。
   */
  error: string | null;
  /**
   * 首次排队时间，用于会话顺序。
   */
  created_at: Date;
}

/**
 * assistant 属于用户会话；approval 属于审批步骤，通过自动角色上下文运行。
 */
export type StoredRun = RunRecord &
  (
    | { mode: 'assistant'; session_id: string; user_id: string; policy: null; approval_step_id: null; process: null }
    | { mode: 'approval'; session_id: null; user_id: null; policy: AiStep; approval_step_id: string; process: string }
  );

/** 老版本留下的无效游标不能进入协议层；业务历史仍可从本地恢复。 */
export function remoteHistory(
  value: RemoteHistory | null,
  key: string | undefined,
  historyLength: number,
): RemoteHistory | null {
  if (!value || !key || value.key !== key || !value.responseId) return null;
  if (!Number.isSafeInteger(value.historyLength) || value.historyLength < 0 || value.historyLength > historyLength)
    return null;
  if (!Number.isSafeInteger(value.contextTokens) || value.contextTokens < 0) return null;
  return value;
}
