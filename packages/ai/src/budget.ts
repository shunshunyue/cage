import { DEFAULT_LIMITS, type AiContextOptions, type ModelProvider, type RunLimits } from './types.js';
import type { ModelReservation } from './state.js';

// 所有窗口策略集中在这里。估算不是模型分词器，因此必须保留余量；输出预算含推理输出。
const WINDOW_HEADROOM = 0.1;
const TOOL_WINDOW_SHARE = 0.25;
const HISTORY_WINDOW_SHARE = 0.4;
export const DEFAULT_MAX_TOOLS = 128;

export interface ModelBudget {
  window: number;
  remaining: number;
  inputLimit: number;
  windowInputLimit: number;
  outputLimit: number;
  toolTokens: number;
  historyTokens: number;
  maxTools: number;
}

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

export function checkModelBudget(limits: RunLimits, steps: number, attempts: number, budget: ModelBudget): void {
  if (
    steps >= limits.maxSteps ||
    attempts >= limits.maxSteps + (limits.maxModelRetries ?? DEFAULT_LIMITS.maxModelRetries!) ||
    budget.inputLimit < 512
  )
    throw new Error('AI_BUDGET_EXCEEDED');
}

export const reservedTokens = (reservation: ModelReservation): number =>
  reservation.inputTokens + reservation.outputTokens;
