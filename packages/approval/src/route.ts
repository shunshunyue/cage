// 代码内封闭路由：一小组固定的组合子（step、when、gt、approver.*），和范围组合子一样只能从里面选，
// 所以抽取器能读懂：改 amount 的口径时，影响分析会把这条路由列出来。
import { ROUTE, SYSTEM_DDL, declError, type Kernel } from '@yss123/cage-kernel';
import { InCodeEngine } from './engine.js';

export type Approver =
  | { kind: 'deptLeader'; field: string }
  | { kind: 'role'; code: string }
  | { kind: 'user'; userId: string };

/** 审批人组合子 */
export const approver = {
  /** 单据某个部门字段对应部门的负责人 */
  deptLeader: (field: string): Approver => ({ kind: 'deptLeader', field }),
  /** 拥有某角色的所有用户 */
  role: (code: string): Approver => ({ kind: 'role', code }),
  /** 指定用户 */
  user: (userId: string): Approver => ({ kind: 'user', userId }),
};

export type Condition =
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: number }
  | { op: 'eq' | 'ne'; field: string; value: string | number | boolean }
  | { op: 'in'; field: string; value: (string | number)[] };

export const gt = (field: string, value: number): Condition => ({ op: 'gt', field, value });
export const gte = (field: string, value: number): Condition => ({ op: 'gte', field, value });
export const lt = (field: string, value: number): Condition => ({ op: 'lt', field, value });
export const lte = (field: string, value: number): Condition => ({ op: 'lte', field, value });
export const eq = (field: string, value: string | number | boolean): Condition => ({ op: 'eq', field, value });
export const ne = (field: string, value: string | number | boolean): Condition => ({ op: 'ne', field, value });
export const isIn = (field: string, value: (string | number)[]): Condition => ({ op: 'in', field, value });

export interface Step {
  kind: 'step';
  title: string;
  approver: Approver;
  /** any：任意一人通过即可（或签）；all：全部通过（会签） */
  mode: 'any' | 'all';
}

export interface When {
  kind: 'when';
  cond: Condition;
  steps: Step[];
}

export type RouteNode = Step | When;

export function step(title: string, who: Approver, opts: { mode?: 'any' | 'all' } = {}): Step {
  return { kind: 'step', title, approver: who, mode: opts.mode ?? 'any' };
}

export function when(cond: Condition, ...steps: Step[]): When {
  return { kind: 'when', cond, steps };
}

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

/** 按流程变量展开出实际要走的步骤 */
export function resolveSteps(nodes: readonly RouteNode[], vars: Record<string, unknown>): Step[] {
  const out: Step[] = [];
  for (const n of nodes) {
    if (n.kind === 'step') out.push(n);
    else if (evalCondition(n.cond, vars)) out.push(...n.steps);
  }
  return out;
}

export interface Route {
  readonly [ROUTE]: true;
  readonly process: string;
  readonly nodes: readonly RouteNode[];
  /** 路由条件和审批人用到的字段（进入本体图的 uses 边） */
  readonly fieldsUsed: readonly string[];
  /** 代码内引擎（worker 与 HTTP 层使用） */
  readonly engine: (k: Kernel) => InCodeEngine;
  readonly [SYSTEM_DDL]: () => string;
}

const engines = new WeakMap<Kernel, Map<string, InCodeEngine>>();

export function route(process: string, nodes: RouteNode[]): Route {
  if (!/^[a-z][a-z0-9-]*$/.test(process)) throw declError('CAGE-APPR-005', `流程名 ${process} 必须是小写短横线`);
  if (nodes.length === 0) throw declError('CAGE-APPR-006', `流程 ${process} 至少需要一个步骤`);
  const fields = new Set<string>();
  for (const n of nodes) {
    const steps = n.kind === 'step' ? [n] : n.steps;
    if (n.kind === 'when') fields.add(n.cond.field);
    for (const s of steps) if (s.approver.kind === 'deptLeader') fields.add(s.approver.field);
  }
  const r: Route = Object.freeze({
    [ROUTE]: true as const,
    process,
    nodes: Object.freeze([...nodes]),
    fieldsUsed: Object.freeze([...fields]),
    engine: (k: Kernel) => {
      let m = engines.get(k);
      if (!m) engines.set(k, (m = new Map()));
      let e = m.get(process);
      if (!e) m.set(process, (e = new InCodeEngine(k, r)));
      return e;
    },
    [SYSTEM_DDL]: () => FLOW_DDL,
  });
  return r;
}

/** 代码内引擎自己的表，放在 flow 模式；引擎没有业务表的写权限 */
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
