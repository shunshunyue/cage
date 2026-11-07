import { sql } from 'kysely';
import type { Ctx, Kernel } from '@yss123/cage-kernel';
import { authFingerprint } from './security.js';
import { messageTokens, packPrompt } from './prompt.js';
import type { ModelMessage } from './types.js';
import type { RemoteHistory, StoredRun } from './state.js';

type HistoryRun = Pick<StoredRun, 'id' | 'input' | 'answer' | 'history' | 'history_start' | 'status'>;

/** 只恢复该运行自身的消息，避免把每轮保存的近期窗口递归复制进下一轮。 */
export function turnHistory(run: HistoryRun): ModelMessage[] {
  const own = run.history.slice(run.history_start);
  if (!own.length)
    return [
      { role: 'user', content: run.input, runId: run.id },
      { role: 'assistant', content: run.answer ?? `上轮状态：${run.status}。执行结果需核对动作回执。`, runId: run.id },
    ];
  const messages: ModelMessage[] = [];
  for (let index = 0; index < own.length; index++) {
    const message = own[index];
    if (message.toolCalls?.length) {
      const ids = new Set(message.toolCalls.map((call) => call.id));
      let end = index + 1;
      while (end < own.length && own[end].role === 'tool' && ids.has(own[end].toolCallId!)) end++;
      if (end - index - 1 !== ids.size) {
        // 失败/取消可以留下未执行调用；不能将其重放为完整调用组或伪造业务成功。
        if (message.content) messages.push({ role: 'assistant', content: message.content, runId: run.id });
        index = end - 1;
        continue;
      }
    }
    if (
      message.role === 'tool' &&
      !messages.some((item) => item.toolCalls?.some((call) => call.id === message.toolCallId))
    )
      continue;
    messages.push({ ...message, runId: run.id });
  }
  if (run.status !== 'succeeded')
    messages.push({
      role: 'assistant',
      content: `上轮状态：${run.status}。未完成操作不能视为成功；用 context_read 核对回执。`,
      runId: run.id,
    });
  return messages;
}

export interface ConversationHistory {
  messages: ModelMessage[];
  omitted: boolean;
  state: RemoteHistory | null;
  disabledKey: string | null;
}

/** 逐页恢复近期完整交互，按 Token 预算停止；完整记录始终可经 context_read 读取。 */
export async function loadConversation(
  kernel: Kernel,
  ctx: Ctx,
  run: StoredRun,
  maxTokens: number,
  stateKey?: string,
): Promise<ConversationHistory> {
  const result: ConversationHistory = { messages: [], omitted: false, state: null, disabledKey: null };
  if (run.mode !== 'assistant') return result;
  let cursor: string | undefined;
  let latest = true;
  for (;;) {
    let query = kernel.app
      .selectFrom('sys.ai_run')
      .select([
        'id',
        'input',
        'answer',
        'history',
        'history_start',
        'status',
        'model',
        'model_state',
        'continuation_disabled_key',
        'created_at',
      ])
      .where('session_id', '=', run.session_id)
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .where('id', '<>', run.id)
      .where('status', 'in', ['succeeded', 'failed', 'cancelled', 'expired'])
      .where('auth_fingerprint', '=', authFingerprint(ctx))
      .where('fingerprint', '=', run.fingerprint)
      .where(sql<boolean>`(created_at, id) < (select created_at, id from sys.ai_run where id = ${run.id}::uuid)`)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(10);
    if (cursor)
      query = query.where(
        sql<boolean>`(created_at, id) < (select created_at, id from sys.ai_run where id = ${cursor}::uuid)`,
      );
    const rows = await query.execute();
    if (!rows.length) break;
    for (const row of rows) {
      if (latest) {
        if (row.model === run.model) {
          result.state = row.status === 'succeeded' ? row.model_state : null;
          result.disabledKey = row.continuation_disabled_key;
        }
        latest = false;
      }
      const messages = turnHistory(row as HistoryRun);
      const combined = [...messages, ...result.messages];
      if (messageTokens(combined, stateKey) > maxTokens) {
        // 最近一轮很大时仍尝试保留完整补充输入和最近工具组，普通证据收起为引用。
        if (!result.messages.length) {
          try {
            result.messages = packPrompt({
              instructions: '',
              context: null,
              tools: [],
              history: messages,
              maxInputTokens: maxTokens,
              stateKey,
            }).messages.slice(1);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'AI_CONTEXT_TOO_LARGE') throw error;
          }
        }
        result.omitted = true;
        return withCursor(result);
      }
      result.messages = combined;
    }
    const last = rows[rows.length - 1];
    cursor = last.id;
  }
  return withCursor(result);
}

function withCursor(history: ConversationHistory): ConversationHistory {
  if (history.state) history.state = { ...history.state, historyLength: history.messages.length };
  return history;
}
