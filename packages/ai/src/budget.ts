/**
 * 模型窗口与整轮额度的集中计算，由请求规划器调用。
 * 使用保守 Token 估计并预留余量；不外呼、不持久化，也不能用于精确计费。
 */
import { DEFAULT_LIMITS, type AiContextOptions, type ModelProvider, type RunLimits } from './types.js';
import type { ModelReservation } from './state.js';

// 所有窗口策略集中在这里。估算不是模型分词器，因此必须保留余量；输出预算含推理输出。
const WINDOW_HEADROOM = 0.1;
/** 默认把总模型窗口的四分之一作为完整工具定义预算；仍受本步实际可用输入空间约束。 */
const TOOL_WINDOW_SHARE = 0.25;
/** 近期历史初始预算占总窗口四成，实际结果还受剩余输入的一半和显式配置上限约束。 */
const HISTORY_WINDOW_SHARE = 0.4;
/**
 * 协议工具默认上限，通用工具和业务工具共同占用。
 */
export const DEFAULT_MAX_TOOLS = 128;

/**
 * 本步冻结的窗口、历史、工具及输出分配；额度不足由调用前检查拒绝。
 */
export interface ModelBudget {
  /**
   * 模型窗口容量。
   */
  window: number;
  /**
   * 整轮未结算的剩余额度。
   */
  remaining: number;
  /**
   * 同时受窗口和剩余额度限制的输入上限。
   */
  inputLimit: number;
  /**
   * 仅按窗口及余量算出的输入上限。
   */
  windowInputLimit: number;
  /**
   * 本次最大输出 Token。
   */
  outputLimit: number;
  /**
   * 完整工具定义预算。
   */
  toolTokens: number;
  /**
   * 近期自动恢复历史预算，最低为零。
   */
  historyTokens: number;
  /**
   * 包含通用工具的协议数量限制。
   */
  maxTools: number;
}

/**
 * 根据模型配置、已结算消耗与应用上限计算本次预算；输出最多占窗口四分之一，历史最多占可用输入一半。
 * @param provider 本步解析的模型快照。
 * @param limits 本轮持久化额度。
 * @param spent 已结算 Token。
 * @param options 历史与工具上限。
 * @returns 各类内容可用容量。
 */
export function modelBudget(
  provider: ModelProvider,
  limits: RunLimits,
  spent: number,
  options: AiContextOptions = {},
): ModelBudget {
  const window = provider.contextWindowTokens ?? 32768;
  const outputLimit = Math.min(limits.maxOutputTokens, Math.floor(window / 4));
  const remaining = limits.tokenBudget - spent;
  const windowInputLimit = Math.floor(window * (1 - WINDOW_HEADROOM)) - outputLimit;
  const inputLimit = Math.min(windowInputLimit, remaining - Math.min(128, outputLimit));
  return {
    window,
    remaining,
    inputLimit,
    windowInputLimit,
    outputLimit,
    toolTokens: Math.min(options.maxToolTokens ?? Math.floor(window * TOOL_WINDOW_SHARE), inputLimit),
    historyTokens: Math.max(
      0,
      Math.min(options.maxHistoryTokens ?? Math.floor(window * HISTORY_WINDOW_SHARE), Math.floor(inputLimit / 2)),
    ),
    maxTools: options.maxTools ?? DEFAULT_MAX_TOOLS,
  };
}

/**
 * 检查有效步数、尝试次数和最低输入空间；超限抛 AI_BUDGET_EXCEEDED，阻止模型外呼。
 */
export function checkModelBudget(limits: RunLimits, steps: number, attempts: number, budget: ModelBudget): void {
  if (
    steps >= limits.maxSteps ||
    attempts >= limits.maxSteps + (limits.maxModelRetries ?? DEFAULT_LIMITS.maxModelRetries!) ||
    budget.inputLimit < 512
  )
    throw new Error('AI_BUDGET_EXCEEDED');
}

/**
 * 预留输入加输出的总数，用于未知结果的保守结算。
 */
export const reservedTokens = (reservation: ModelReservation): number =>
  reservation.inputTokens + reservation.outputTokens;
