/**
 * 按当前授权和 Token 预算恢复同一助理会话的近期历史。
 * 运行时准备新轮上下文时调用；持久记录完整保留，窗口裁剪只影响本次模型输入，失败或取消的工具调用不会被伪装成成功历史。
 */
import { sql } from 'kysely';
import type { Ctx, Kernel } from '@yss123/cage-kernel';
import { authFingerprint } from './security.js';
import { messageTokens, packPrompt } from './prompt.js';
import type { ModelMessage } from './types.js';
import type { RemoteHistory, StoredRun } from './state.js';

/**
 * 恢复一轮消息所需的持久字段子集；history_start 把本轮消息与当时借用的前轮窗口分开，避免递归重复历史。
 */
type HistoryRun = Pick<StoredRun, 'id' | 'input' | 'answer' | 'history' | 'history_start' | 'status'>;

/** 只恢复该运行自身的消息，避免把每轮保存的近期窗口递归复制进下一轮。 */
/**
 * 提取运行自身的消息并清理不完整工具调用组及孤立回执。
 * 没有消息时用原始任务和最终状态构造最小交互；非成功运行追加需核对回执的提示，不能把未完成调用重放成已成功动作。返回新数组，不修改持久历史。
 */
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

/**
 * 已恢复的可发送消息和远端接续信息。
 * omitted 只表示本次上下文预算省略了旧资料，完整历史仍保留；state 是否真正可用由请求规划再次核对配置键。
 */
export interface ConversationHistory {
  /**
   * 按对话顺序排列的已恢复统一消息，可能包含已压缩证据引用。
   */
  messages: ModelMessage[];
  /**
   * 是否因本次预算省略较早资料；不能据此断言历史不存在。
   */
  omitted: boolean;
  /**
   * 最近可承接的远端响应状态；null 表示从本地消息重建。
   */
  state: RemoteHistory | null;
  /**
   * 此前证实不支持接续的 provider 配置键；配置变化后可重新判断。
   */
  disabledKey: string | null;
}

/** 逐页恢复近期完整交互，按 Token 预算停止；完整记录始终可经 context_read 读取。 */
/**
 * 只为 assistant 按 created_at/id 游标逐页恢复此前已结束运行，每页 10 条。
 * 限定同会话、租户、用户、当前权限指纹和注册表指纹；只从最近一轮同模型且成功的记录承接远端状态。
 * 优先保留完整近期轮次，最近一轮本身超预算时尝试压缩为引用，不能容纳则标记 omitted；不会删除数据库历史或放宽授权。
 */
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

/**
 * 把远端状态的 historyLength 对齐到实际恢复的消息数。
 * 该游标使接续请求只发送新增消息，修改的是当前恢复结果，不回写历史运行。
 */
function withCursor(history: ConversationHistory): ConversationHistory {
  if (history.state) history.state = { ...history.state, historyLength: history.messages.length };
  return history;
}
