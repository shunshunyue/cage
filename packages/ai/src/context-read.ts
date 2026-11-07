import { cageError } from '@yss123/cage-kernel';
import type { Execution } from './types.js';
import { contextPreview } from './prompt.js';
import { turnHistory } from './history.js';
import type { StoredRun } from './state.js';

export interface ContextReadInput {
  source: 'context' | 'action' | 'conversation';
  runId?: string;
  ref?: string;
  path: (string | number)[];
  offset: number;
  limit: number;
}
/** 模型只取得已授权运行的资料引用，不能指定表名、SQL 或跨会话读取。 */
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
