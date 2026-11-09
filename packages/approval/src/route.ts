/**
 * 代码内封闭审批声明：组合子保存条件、选人、分配与任务政策，由注册表/CLI 抽取、引擎创建实例。
 * 字段选人与条件进入 fieldsUsed 依赖；运行实例保存步骤快照，后来改代码不会改写在途规则。
 * 这里不授予业务权限或执行任意脚本；新结构只追加迁移，历史 FLOW_DDL 内容保持不变。
 */
import { ROUTE, SYSTEM_DDL, MIGRATIONS, declError, stableStringify, type Kernel, type Registry } from '@yss123/cage-kernel';
import { createHash } from 'node:crypto';
import { compileSteps, inspectRoute, type ExecutableStep } from './execution.js';
import { InCodeEngine } from './engine.js';
import { APPROVAL_AI_MIGRATION, type AiStep, type AiStepOptions } from './ai.js';
import { APPROVAL_TASK_ACTIONS_MIGRATION, type TaskActionPolicy } from './task-actions.js';
import { APPROVAL_TASK_STAGES_MIGRATION } from './task-stages.js';
import { APPROVAL_DEADLINES_MIGRATION, approvalSla, approvalReminderPolicy, type ApprovalSla, type ApprovalReminderPolicy } from './deadlines.js';

/** 封闭选人策略，仅决定候选执行人；被选中不代表拥有目标业务命令能力、数据范围或额度。 */
export type Approver =
  | { kind: 'deptLeader'; field: string }
  | { kind: 'role'; code: string }
  | { kind: 'field'; field: string }
  | { kind: 'user'; userId: string };

/** 审批人组合子 */
export const approver = {
  /** 单据某个部门字段对应部门的负责人 */
  deptLeader: (field: string): Approver => ({ kind: 'deptLeader', field }),
  /** 拥有某角色的所有用户 */
  role: (code: string): Approver => ({ kind: 'role', code }),
  /** 指定用户 */
  user: (userId: string): Approver => ({ kind: 'user', userId }),
  /** 从 routable 单据字段读取 UUID 或 UUID 数组；值随实例冻结，仍须业务授权，不接受任意 JS。 */
  field: (field: string): Approver => ({ kind: 'field', field }),
};

/** 可静态分析的分支条件；field 应进入 approval.routable，运行时只读取流程变量。 */
export type Condition =
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: number }
  | { op: 'eq' | 'ne'; field: string; value: string | number | boolean }
  | { op: 'in'; field: string; value: (string | number)[] };

/** 数值比较组合子将业务字段和阈值保留在声明中，金额字符串在 evalCondition 中转换比较。 */
export const gt = (field: string, value: number): Condition => ({ op: 'gt', field, value });
export const gte = (field: string, value: number): Condition => ({ op: 'gte', field, value });
export const lt = (field: string, value: number): Condition => ({ op: 'lt', field, value });
export const lte = (field: string, value: number): Condition => ({ op: 'lte', field, value });
export const eq = (field: string, value: string | number | boolean): Condition => ({ op: 'eq', field, value });
export const ne = (field: string, value: string | number | boolean): Condition => ({ op: 'ne', field, value });
export const isIn = (field: string, value: (string | number)[]): Condition => ({ op: 'in', field, value });

/** 人工节点；direct 创建逐人审批票，candidate 创建共享待领取任务；追加票始终必签。 */
export interface Step {
  kind: 'step';
  title: string;
  approver: Approver;
  /** any：任意一人通过即可（或签）；all：全部通过（会签） */
  mode: 'any' | 'all';
  /** direct（默认）逐人分配；candidate 建立一项未领取任务，只能搭配 any，领取时重新核对候选规则。 */
  assignment?: 'direct' | 'candidate';
  /** step 自动保存的新加签位置政策；旧实例缺省仅 parallel，升级不能自动开放挂起/后签行为。 */
  readonly signPositions?: readonly ('parallel' | 'before' | 'after')[];
  /** 可选任务流转政策；默认关闭。启动时随步骤保存，代码更新不改变在途实例。 */
  actions?: Readonly<TaskActionPolicy>;
  /** 节点总办理自然分钟时限，进入节点后持久固定；前后加签/转办不重置，不自动改变结论。 */
  sla?: Readonly<ApprovalSla>;
}

/** 条件满足才展开内部步骤；未满足时跳过这一分支，不生成空待办。 */
export interface When {
  kind: 'when';
  cond: Condition;
  steps: RouteNode[];
}

export type ApprovalStep = Step | AiStep;
/** 并行组中的具名顺序分支；只有所属 parallel 能启动它，不作为独立根节点执行。 */
export interface Branch {
  /** 固定判别值，防止把分支误当作人工步骤。 */
  kind: 'branch';
  /** 同一并行组内唯一的可读名称，进入历史分支路径。 */
  title: string;
  /** 分支内部按声明顺序推进，可包含条件和嵌套并行组。 */
  nodes: RouteNode[];
}
/** AND 并行组：各分支从共同入口启动，全部实际展开的分支完成才进入后续节点。 */
export interface Parallel {
  kind: 'parallel';
  /** 可读并行组标题，用于图谱、待办与历史定位。 */
  title: string;
  /** 2–16 个具名分支；名称在组内不能重复。 */
  branches: Branch[];
}
/** 结构化流程节点；没有任意连线、循环或运行时重算条件的含义。 */
export type RouteNode = ApprovalStep | When | Parallel;

/** 创建具名分支，内部可顺序执行多步；只保存声明，结构预算在 route 构建时统一验证。 */
export function branch(title: string, ...nodes: RouteNode[]): Branch { return { kind: 'branch', title, nodes }; }

/** 声明 AND 分支与汇合；一条分支拒绝/退回时结束整轮，全部通过才继续，选人不授予权限。 */
export function parallel(title: string, ...branches: Branch[]): Parallel { return { kind: 'parallel', title, branches }; }

/**
 * 同一个步骤原语支持人工和 AI 两类执行方式。AI 必须声明模型、要求、取证字段和人工接管规则，
 * 正数预算在声明时检查；人工默认 any。此处只描述节点，不创建实例或执行模型请求。
 */
export function step(title: string, who: Approver, opts?: { mode?: 'any' | 'all'; assignment?: 'direct' | 'candidate'; actions?: TaskActionPolicy; sla?: ApprovalSla }): Step;
export function step(title: string, who: AiStepOptions): AiStep;
export function step(title: string, who: Approver | AiStepOptions, opts: { mode?: 'any' | 'all'; assignment?: 'direct' | 'candidate'; actions?: TaskActionPolicy; sla?: ApprovalSla } = {}): ApprovalStep {
  if (who.kind === 'ai') {
    if (!who.model?.trim() || !who.instructions?.trim() || !who.handoff || !who.context?.fields.length)
      throw declError('CAGE-APPR-006', 'AI 步骤需要模型、审核要求、上下文字段和接管规则');
    for (const value of Object.values(who.limits ?? {})) if (!Number.isSafeInteger(value) || value! <= 0)
      throw declError('CAGE-APPR-006', 'AI 步骤运行预算必须是正整数');
    return Object.freeze({ ...who, title, context: { fields: [...who.context.fields], queries: [...(who.context.queries ?? [])] } });
  }
  if (opts.actions && Object.entries(opts.actions).some(([name, value]) => !['transfer', 'delegate', 'addSign'].includes(name) || typeof value !== 'boolean'))
    throw declError('CAGE-APPR-006', '人工步骤的 actions 只接受 transfer/delegate/addSign 布尔值');
  if ((opts.assignment !== undefined && !['direct', 'candidate'].includes(opts.assignment)) || (opts.assignment === 'candidate' && opts.mode === 'all'))
    throw declError('CAGE-APPR-006', '候选领取只支持 any；逐人会签请使用默认 direct');
  return { kind: 'step', title, approver: who, mode: opts.mode ?? 'any', ...(opts.assignment ? { assignment: opts.assignment } : {}),
    ...(opts.sla ? { sla: approvalSla(opts.sla) } : {}),
    ...(opts.actions?.addSign ? { signPositions: Object.freeze(['parallel', 'before', 'after'] as const) } : {}),
    ...(opts.actions ? { actions: Object.freeze({ ...opts.actions }) } : {}) };
}

/** 将一组顺序步骤置于同一个条件下，条件求值发生在实例创建时。 */
export function when(cond: Condition, ...steps: RouteNode[]): When {
  return { kind: 'when', cond, steps };
}

/** 使用封闭运算符求值，不执行任意表达式；比较转换规则固定，业务阈值边界应另有回归用例。 */
export function evalCondition(c: Condition, vars: Record<string, unknown>): boolean {
  const v = vars[c.field];
  switch (c.op) {
    case 'gt': return Number(v) > c.value;
    case 'gte': return Number(v) >= c.value;
    case 'lt': return Number(v) < c.value;
    case 'lte': return Number(v) <= c.value;
    case 'eq': return String(v) === String(c.value);
    case 'ne': return String(v) !== String(c.value);
    case 'in': return c.value.map(String).includes(String(v));
    default: return false;
  }
}

/** 按提交变量展开节点并携带冻结的依赖；返回顺序是节点索引顺序，实际执行以 execution.dependsOn 为准。 */
export function resolveSteps(nodes: readonly RouteNode[], vars: Record<string, unknown>): ExecutableStep[] {
  inspectRoute(nodes);
  return compileSteps(nodes, vars, createHash('sha256').update(stableStringify(nodes)).digest('hex'));
}

/** 代码路由兼具可检查规格与引擎工厂；实例/待办表由迁移准备，注册路由本身不会访问数据库。 */
export interface Route {
  readonly [ROUTE]: true;
  readonly process: string;
  readonly nodes: readonly RouteNode[];
  /** 完整声明内容的 SHA256 指纹；实例保存该版本，发布新代码不会重算已有依赖或节点政策。 */
  readonly definitionVersion: string;
  /** 路由条件和审批人用到的字段（进入本体图的 uses 边） */
  readonly fieldsUsed: readonly string[];
  /** 显式申请人催办政策；随实例保存，升级不向既有无政策实例开放催办。 */
  readonly reminders?: Readonly<ApprovalReminderPolicy>;
  /** 代码内引擎（worker 与 HTTP 层使用） */
  readonly engine: (k: Kernel) => InCodeEngine;
  readonly [SYSTEM_DDL]: () => string;
  readonly [MIGRATIONS]: () => readonly { name: string; sql: string }[];
  validate(registry: Registry): void;
}

const engines = new WeakMap<Kernel, Map<string, InCodeEngine>>();

/**
 * 构造流程声明并收集条件/部门选人字段，用于图谱依赖检查；按 kernel 与 process 缓存引擎实例。
 * 注册表完成后 validate 继续核对 AI 运行时、自动角色、退回命令和取证字段/查询，尽早暴露缺失声明。
 * nodes 保存原有步骤顺序，业务实例创建时会冻结展开后的步骤，后续不会随代码分支重新求值。
 */
export function route(process: string, nodes: RouteNode[], options: { reminders?: ApprovalReminderPolicy } = {}): Route {
  if (!/^[a-z][a-z0-9-]*$/.test(process)) throw declError('CAGE-APPR-005', `流程名 ${process} 必须是小写短横线`);
  if (nodes.length === 0) throw declError('CAGE-APPR-006', `流程 ${process} 至少需要一个步骤`);
  const inspection = inspectRoute(nodes);
  const fields = new Set<string>(inspection.fields);
  const reminders = options.reminders === undefined ? undefined : approvalReminderPolicy(options.reminders);
  if (reminders) fields.add(reminders.requesterField);
  for (const s of inspection.steps) {
      const selector = s.kind === 'ai' ? s.handoff : s.approver;
      if (selector.kind === 'deptLeader' || selector.kind === 'field') fields.add(selector.field);
  }
  // 声明必须与指纹同时冻结；拷贝调用者的对象，避免其后修改数组让注册表与实例版本不一致。
  const frozenNodes: RouteNode[] = JSON.parse(JSON.stringify(nodes));
  const freeze = (value: any): void => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(frozenNodes);
  const definitionVersion = createHash('sha256').update(stableStringify({ schema: 1, process, nodes: frozenNodes, reminders })).digest('hex');
  const r: Route = Object.freeze({
    [ROUTE]: true as const,
    process,
    nodes: frozenNodes,
    definitionVersion,
    ...(reminders ? { reminders } : {}),
    fieldsUsed: Object.freeze([...fields]),
    engine: (k: Kernel) => {
      let m = engines.get(k);
      if (!m) engines.set(k, (m = new Map()));
      let e = m.get(process);
      if (!e) m.set(process, (e = new InCodeEngine(k, r)));
      return e;
    },
    [SYSTEM_DDL]: () => FLOW_DDL,
    [MIGRATIONS]: () => [APPROVAL_AI_MIGRATION, APPROVAL_TASK_ACTIONS_MIGRATION, APPROVAL_TASK_STAGES_MIGRATION, APPROVAL_DEADLINES_MIGRATION],
    validate: (registry: Registry) => {
      const routeBinding = registry.approvalByProcess(process)?.a;
      // 时限和申请人催办都依赖独立后台运行时，声明遗漏必须在构建阶段报错，不能部署后悄悄无提醒。
      const declaredSteps = inspectRoute(frozenNodes).steps;
      const hasSla = declaredSteps.some(node => node.kind !== 'ai' && node.sla);
      if ((reminders || hasSla) && !registry.extensions.some(ext => ext.kind === 'RUNTIME' && ext.value.name === 'approval-operations'))
        throw declError('CAGE-APPR-006', '审批 SLA 或 reminders 必须显式导出 approvalOperations()');
      if (reminders && (!routeBinding?.routable.includes(reminders.requesterField) || !routeBinding.agg.fields[reminders.requesterField] || routeBinding.agg.fields[reminders.requesterField].isHidden))
        throw declError('CAGE-APPR-001', `申请人字段 ${reminders.requesterField} 必须存在、可公开且进入 routable`);
      for (const node of declaredSteps) {
        const selector = node.kind === 'ai' ? node.handoff : node.approver;
        // 新字段选择器必须能从 routable 快照取值；不追溯改变历史部门选人的声明校验行为。
        if (selector.kind === 'field' && (!routeBinding?.routable.includes(selector.field) || !routeBinding.agg.fields[selector.field] || routeBinding.agg.fields[selector.field].isHidden))
          throw declError('CAGE-APPR-001', `审批人员字段 ${selector.field} 必须存在、可公开且进入 routable`);
      }
      const aiSteps = declaredSteps.filter((s): s is AiStep => s.kind === 'ai');
      if (!aiSteps.length) return;
      if (!registry.extensions.some(e => e.kind === 'RUNTIME' && e.value.name === 'ai')) throw declError('CAGE-APPR-006', 'AI 审批必须启用 cage-ai 运行时');
      const binding = registry.approvalByProcess(process)?.a;
      if (!binding?.onReturned || !binding.automatedBy) throw declError('CAGE-APPR-006', `AI 审批 ${process} 必须绑定 onReturned 和 automatedBy`);
      for (const s of aiSteps) {
        for (const field of s.context.fields) if (!binding.agg.fields[field] || binding.agg.fields[field].isHidden)
          throw declError('CAGE-APPR-001', `AI 上下文字段 ${field} 不存在或不可公开`);
        for (const query of s.context.queries ?? []) if (!registry.queries.some(q => q.name === query))
          throw declError('CAGE-REG-001', `AI 步骤引用的查询 ${query} 未导出`);
      }
    },
  });
  return r;
}

/** 代码内引擎自己的表，放在 flow 模式；引擎没有业务表的写权限 */
/** 此 SQL 是已发布扩展 DDL 的内容摘要来源；新增字段通过独立 MIGRATIONS 追加，不能改写历史字符串。 */
export const FLOW_DDL = `
CREATE TABLE IF NOT EXISTS flow.approval_instance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  process text NOT NULL,
  aggregate text NOT NULL,
  business_key uuid NOT NULL,
  vars jsonb NOT NULL,
  steps jsonb NOT NULL,
  current_step int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  last_approver uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_instance_key_idx ON flow.approval_instance (tenant_id, business_key, status);
CREATE TABLE IF NOT EXISTS flow.approval_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES flow.approval_instance(id),
  tenant_id uuid NOT NULL,
  step int NOT NULL,
  title text NOT NULL,
  assignee uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  comment text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_task_assignee_idx ON flow.approval_task (tenant_id, assignee, status);
GRANT SELECT, INSERT, UPDATE ON flow.approval_instance, flow.approval_task TO cage_app;
`;
