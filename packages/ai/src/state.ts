import type { AiStep } from '@yss123/cage-approval';
import type { AiPersonality, AiRunStatus, PageContext } from '@yss123/cage-ai-protocol';
import type { ModelMessage, RunLimits, ToolCall } from './types.js';

/** 远端游标只描述可接续的历史；协议兼容性单独保存，不能随游标重建而丢失。 */
export interface RemoteHistory {
  key: string;
  responseId: string;
  historyLength: number;
  contextTokens: number;
}

export interface ModelReservation {
  attempt: number;
  step: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
}

export interface ToolPlan {
  mode: 'all' | 'discovery';
  tokenBudget: number;
  maxTools: number;
}

interface RunRecord {
  id: string;
  tenant_id: string;
  status: AiRunStatus;
  phase: 'context' | 'model' | 'actions' | 'done';
  input: string;
  page_context: PageContext | null;
  context: Record<string, unknown> | null;
  history: ModelMessage[];
  history_start: number;
  history_omitted: boolean;
  pending: ToolCall[];
  model: string;
  instructions: string;
  limits: RunLimits;
  personality: AiPersonality | null;
  fingerprint: string;
  auth_fingerprint: string | null;
  auth_session: string | null;
  delegated_until: Date;
  step_up_at: number | null;
  steps: number;
  tokens: number;
  tool_calls: number;
  tool_keys: string[] | null;
  tool_plan: ToolPlan | null;
  model_state: RemoteHistory | null;
  continuation_disabled_key: string | null;
  model_attempts: number;
  model_reservation: ModelReservation | null;
  lease_token: string | null;
  lease_until: Date | null;
  deadline: Date | null;
  cancelled: boolean;
  answer: string | null;
  error: string | null;
  created_at: Date;
}

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
