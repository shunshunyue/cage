/**
 * 提供模型对已保存上下文、动作回执和会话历史的分页读取。
 * 由 context_read 工具调用，使用运行的主体、会话和指纹限定证据范围；只读取持久化资料，不接受 SQL、表名，也不重新执行原业务动作。
 */
import { cageError } from '@yss123/cage-kernel';
import type { Execution } from './types.js';
import { contextPreview } from './prompt.js';
import { turnHistory } from './history.js';
import type { StoredRun } from './state.js';

/**
 * 上下文引用的导航和分页参数；由工具 schema 校验后传入。
 * source 决定证据来源，path 只访问自有属性；对象页的 limit 与字符串固定 4000 字符页分别处理。
 */
export interface ContextReadInput {
  /**
   * context 为页面/审批上下文，action 为动作回执，conversation 为同会话运行历史。
   */
  source: 'context' | 'action' | 'conversation';
  /**
   * 可选目标运行 ID；省略时读当前运行，conversation 无 ID 时返回历史目录。
   */
  runId?: string;
  /**
   * 动作 ID；action 省略时返回已结束动作目录，其他来源不用于查表。
   */
  ref?: string;
  /**
   * 从来源根对象出发的字段名或数组索引；只允许已有自有属性。
   */
  path: (string | number)[];
  /**
   * 零基偏移；字符串按字符，数组/对象/目录按条目计数。
   */
  offset: number;
  /**
   * 对象和目录的单页条数；字符串独立固定最多 4000 字符。
   */
  limit: number;
}
/** 模型只取得已授权运行的资料引用，不能指定表名、SQL 或跨会话读取。 */
/**
 * 在当前运行授权边界内展开资料引用或目录，返回可继续翻页的 nextOffset。
 * 审批模式禁止读取会话和其他运行；助理跨运行必须匹配会话、租户、用户、权限指纹与注册表指纹。
 * 动作目录只列已结束动作，会话详情移除 provider 私有项；对象/数组子项缩成 800 字符预算内预览，完整内容可沿 path 继续获取。不存在或越界引用拒绝返回，不通过重新执行工具补数据。
 */
export async function readContext(execution: Execution, input: ContextReadInput): Promise<unknown> {
  const { run, kernel } = execution;
  if (run.mode === 'approval' && (input.source === 'conversation' || (input.runId && input.runId !== run.id)))
    throw cageError('FORBIDDEN');
  let selected = run;
  if (input.runId && input.runId !== run.id) {
    const found = await kernel.app
      .selectFrom('sys.ai_run')
      .selectAll()
      .where('id', '=', input.runId)
      .where('session_id', '=', run.session_id)
      .where('tenant_id', '=', run.tenant_id)
      .where('user_id', '=', run.user_id)
      .where('auth_fingerprint', '=', run.auth_fingerprint)
      .where('fingerprint', '=', run.fingerprint)
      .executeTakeFirst();
    if (!found) throw cageError('NOT_FOUND');
    selected = found as StoredRun;
  }
  let value: any;
  if (input.source === 'context') value = selected.context;
  else if (input.source === 'action') {
    if (input.ref) {
      const action = await kernel.app
        .selectFrom('sys.ai_action')
        .select(['tool', 'result'])
        .where('id', '=', input.ref)
        .where('run_id', '=', selected.id)
        .where('tenant_id', '=', run.tenant_id)
        .executeTakeFirst();
      if (!action) throw cageError('NOT_FOUND');
      value = action.result;
    } else {
      const actions = await kernel.app
        .selectFrom('sys.ai_action')
        .select(['id', 'tool', 'status', 'created_at'])
        .where('run_id', '=', selected.id)
        .where('status', 'in', ['succeeded', 'failed'])
        .orderBy('created_at')
        .limit(input.limit + 1)
        .offset(input.offset)
        .execute();
      return {
        runId: selected.id,
        source: 'action',
        items: actions.slice(0, input.limit),
        nextOffset: actions.length > input.limit ? input.offset + input.limit : null,
      };
    }
  } else if (input.runId)
    value = {
      input: selected.input,
      answer: selected.answer,
      status: selected.status,
      messages: turnHistory(selected).map(({ providerItems: _privateItems, ...message }) => message),
    };
  else {
    const rows = await kernel.app
      .selectFrom('sys.ai_run')
      .select(['id', 'input', 'created_at'])
      .where('session_id', '=', run.session_id)
      .where('tenant_id', '=', run.tenant_id)
      .where('user_id', '=', run.user_id)
      .where('status', 'in', ['succeeded', 'failed', 'cancelled', 'expired'])
      .where('auth_fingerprint', '=', run.auth_fingerprint)
      .where('fingerprint', '=', run.fingerprint)
      .orderBy('created_at', 'desc')
      .limit(input.limit + 1)
      .offset(input.offset)
      .execute();
    return {
      source: 'conversation',
      items: rows
        .slice(0, input.limit)
        .map((row) => ({ id: row.id, input: row.input.slice(0, 160), createdAt: row.created_at })),
      nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
    };
  }
  for (const part of input.path) {
    if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part)) throw cageError('NOT_FOUND');
    value = value[part];
  }
  const ref = { source: input.source, runId: selected.id, ref: input.ref, path: input.path };
  if (typeof value === 'string')
    return {
      ...ref,
      total: value.length,
      offset: input.offset,
      text: value.slice(input.offset, input.offset + 4000),
      nextOffset: input.offset + 4000 < value.length ? input.offset + 4000 : null,
    };
  if (value == null || typeof value !== 'object') return { ...ref, value };
  const entries = Array.isArray(value) ? value.map((v, index) => [index, v] as const) : Object.entries(value);
  return {
    ...ref,
    total: entries.length,
    offset: input.offset,
    nextOffset: input.offset + input.limit < entries.length ? input.offset + input.limit : null,
    items: entries
      .slice(input.offset, input.offset + input.limit)
      .map(([key, item]) => ({ path: [...input.path, key], value: contextPreview(item, 800) })),
  };
}
