/**
 * 追加模型调用预留与接续兼容性迁移，由系统迁移器执行。
 * 旧 steps 转为已知尝试计数，接续禁用状态独立保存；历史 SQL 与迁移标识不得因注释维护改写。
 */
/** 追加迁移：预留额度与已结算消耗分开，旧运行保持原有审计计数。 */
export const EXECUTION_MIGRATION = {
  name: 'cage:ai_execution_001',
  sql: `
ALTER TABLE sys.ai_run
 ADD COLUMN model_attempts integer NOT NULL DEFAULT 0 CHECK (model_attempts >= 0),
 ADD COLUMN model_reservation jsonb,
 ADD COLUMN continuation_disabled_key text,
 ADD COLUMN tool_plan jsonb,
 ADD COLUMN history_omitted boolean NOT NULL DEFAULT false;
UPDATE sys.ai_run SET model_attempts = steps;
UPDATE sys.ai_run SET continuation_disabled_key = model_state->>'key', model_state = NULL
 WHERE model_state->>'continuationDisabled' = 'true';
`,
};
