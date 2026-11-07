import { cageError, mergeCaps, mergeScopes, unmaskFrom, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { Approver } from './route.js';

/** AI 是步骤执行类型，handoff 仅指定本步骤的接管人，不嵌入第二条流程。 */
export interface AiStepOptions {
  kind: 'ai';
  model: string;
  instructions: string;
  context: { fields: readonly string[]; queries?: readonly string[] };
  handoff: Approver;
  limits?: { maxSteps?: number; maxToolCalls?: number; tokenBudget?: number; timeoutMs?: number };
  onFailure?: 'manual' | 'failed';
}
export interface AiStep extends AiStepOptions { title: string }
export interface AiDecision {
  decision: 'pass' | 'return' | 'manual';
  reason: string;
  suggestions: string[];
  evidence: { source: string; detail: string }[];
}

/** 角色授权只赋予流程服务主体；不借用用户身份，也不继承 systemCtx 的全部范围。 */
export async function approvalRoleContext(kernel: Kernel, process: string, tenantId: string): Promise<Ctx> {
  const binding = kernel.registry.approvalByProcess(process)?.a;
  if (!binding?.automatedBy) throw cageError('FORBIDDEN', { reason: '审批未配置自动执行角色' });
  const role = await kernel.app.selectFrom('sys.role').select(['capabilities', 'scopes']).where('tenant_id', '=', tenantId)
    .where('code', '=', binding.automatedBy).where('status', '=', 'active').executeTakeFirst();
  if (!role) throw cageError('FORBIDDEN', { reason: '自动执行角色不存在或已禁用' });
  const capabilities = mergeCaps([role]);
  return { actor: { kind: 'process', id: `process:${process}:role:${binding.automatedBy}` }, userId: null, tenantId,
    deptId: null, deptPath: null, capabilities, scopes: mergeScopes([role]), unmask: unmaskFrom(capabilities), source: 'process' };
}

/** 追加迁移，保留原 FLOW_DDL 的已发布内容。 */
export const APPROVAL_AI_MIGRATION = {
  name: 'cage:approval_ai_001',
  sql: `
ALTER TABLE flow.approval_instance ADD COLUMN subject_version integer;
ALTER TABLE flow.approval_instance ADD COLUMN start_event_id bigint;
ALTER TABLE flow.approval_instance ADD COLUMN last_actor jsonb;
CREATE TABLE flow.approval_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES flow.approval_instance(id),
  step integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human','ai')),
  status text NOT NULL,
  expected_version integer,
  run_id uuid,
  decision jsonb,
  decision_visibility jsonb,
  actor jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(instance_id, step)
);
CREATE INDEX approval_step_queue_idx ON flow.approval_step(status, created_at) WHERE kind = 'ai';
GRANT SELECT, INSERT, UPDATE ON flow.approval_step TO cage_app;
`,
};
