/**
 * AI 审批的声明协议、受限角色上下文与前向迁移。模型循环在 cage-ai 中执行，
 * 此模块不直接调用模型、不创建另一套流程；AI 结果仍进入 InCodeEngine 的当前步骤。
 */
import { cageError, mergeCaps, mergeScopes, unmaskFrom, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { Approver } from './route.js';

/** AI 是步骤执行类型，handoff 仅指定本步骤的接管人，不嵌入第二条流程。 */
export interface AiStepOptions {
  kind: 'ai';
  /** 应用 AI 配置中的模型名，不在业务声明中保存供应商密钥。 */
  model: string;
  /** 节点审核政策；表达判定要求，不赋予超出自动角色的工具或数据权限。 */
  instructions: string;
  /** 允许取证的字段与已注册只读查询，字段须公开且实际访问仍受角色授权约束。 */
  context: { fields: readonly string[]; queries?: readonly string[] };
  /** 当前步骤转人工时的选人策略；不是另起一条无关审批流程。 */
  handoff: Approver;
  /** 单次执行预算：步骤数、工具调用数、token 数和毫秒超时，均应为正整数。 */
  limits?: { maxSteps?: number; maxToolCalls?: number; tokenBudget?: number; timeoutMs?: number };
  /** 模型/工具失败后的处理政策；故障不等同于正常通过。 */
  onFailure?: 'manual' | 'failed';
}
export interface AiStep extends AiStepOptions { title: string }
/** 三态审核结果；pass 只通过本节点，return 走领域退回命令，manual 生成本节点人工待办。 */
export interface AiDecision {
  decision: 'pass' | 'return' | 'manual';
  reason: string;
  suggestions: string[];
  evidence: { source: string; detail: string }[];
}

/** 角色授权只赋予流程服务主体；不借用用户身份，也不继承 systemCtx 的全部范围。 */
/**
 * 每次从当前租户的 active 角色解析能力/范围/明文权限，不缓存旧授权、不借用真人身份。
 * 角色缺失或未配置立即 FORBIDDEN；因为没有部门上下文，范围政策不能假定自动主体属于某个部门。
 */
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
/** 节点记录保存针对的提交版本、run 归属、判定及可见性证据；同实例/步骤唯一，防重复占位。 */
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
