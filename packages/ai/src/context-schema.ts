/** 新迁移不改写已有系统迁移；旧模型继续使用 Chat Completions。 */
export const CONTEXT_MIGRATION = { name: 'cage:ai_context_001', sql: `
ALTER TABLE sys.ai_model
 ADD COLUMN api_format text NOT NULL DEFAULT 'chat-completions' CHECK (api_format IN ('chat-completions','responses')),
 ADD COLUMN context_window_tokens integer NOT NULL DEFAULT 32768 CHECK (context_window_tokens BETWEEN 8192 AND 2000000),
 ADD COLUMN responses_compaction boolean NOT NULL DEFAULT false;
ALTER TABLE sys.ai_run
 ADD COLUMN tool_keys jsonb,
 ADD COLUMN history_start integer NOT NULL DEFAULT 0,
 ADD COLUMN model_state jsonb;
` };
