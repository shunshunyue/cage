/**
 * 追加上下文系统迁移，供 ai() 按历史顺序注册给迁移器。
 * 添加协议/窗口、工具 key、历史起点和远端状态；模块导入不执行 SQL，已发布 SQL 保持不变。
 */
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
