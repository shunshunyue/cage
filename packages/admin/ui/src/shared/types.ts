// 管理页面只持有 HTTP 展示模型，不导入领域或内核实现。
export interface Me {
  user: { id: string; name: string; username: string };
  capabilities: string[];
}
export interface Capability {
  capability: string;
  kind: 'command' | 'read' | 'export' | 'unmask' | 'system';
  aggregate?: string;
  description?: string;
  label: string;
  invokedBy?: string[];
}
export interface Aggregate {
  name: string;
  label: string;
  description?: string;
  scope: { deptField: string | null; ownerField: string | null };
}
export interface Catalog {
  capabilities: Capability[];
  aggregates: Aggregate[];
  combinators: string[];
  labels: Record<string, string>;
  approvals: { name: string; process: string; aggregate: string; label: string }[];
  jobs: { name: string; label: string }[];
}
export interface List<T> {
  items: T[];
  total: number;
}
export type ScopeKind = 'self' | 'dept' | 'deptSubtree' | 'deptSet' | 'all';
export interface Role {
  id: string;
  name: string;
  code: string;
  status: string;
  capabilities: { capability: string; params: Record<string, unknown> | null }[];
  scopes: { aggregate: string; combinator: ScopeKind; deptIds?: string[] | null }[];
}
export interface Dept {
  id: string;
  name: string;
  code: string | null;
  leaderId: string | null;
  ancestors: string;
  status: string;
}
export interface User {
  id: string;
  username: string;
  name: string;
  deptId: string;
  roleIds: string[];
  status: string;
}
