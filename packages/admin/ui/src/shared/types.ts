/**
 * 系统管理前端使用的 HTTP 展示类型，不引入内核、数据库或领域模块。
 * 类型描述客户端实际消费的字段；授权、掩码和输入校验在服务端执行，接口类型本身没有安全作用。
 */
// 管理页面只持有 HTTP 展示模型，不导入领域或内核实现。
/**
 * 当前登录会话摘要：user 是显示身份，capabilities 是界面判断使用的能力标识列表。
 */
export interface Me {
  user: { id: string; name: string; username: string };
  capabilities: string[];
}
/**
 * 目录中的单个能力。capability 是稳定授权标识，label/description 为显示文字；
 * kind 区分命令、读取、导出、敏感明文与系统入口，aggregate 可缺省，invokedBy 说明合法调用来源。
 */
export interface Capability {
  capability: string;
  kind: 'command' | 'read' | 'export' | 'unmask' | 'system';
  aggregate?: string;
  description?: string;
  label: string;
  invokedBy?: string[];
}
/**
 * 管理页面需要的聚合元数据。scope 两个可空字段名说明支持哪些记录归属，
 * null 表示该归属字段未配置，不表示所有人拥有访问权限。
 */
export interface Aggregate {
  name: string;
  label: string;
  description?: string;
  scope: { deptField: string | null; ownerField: string | null };
}
/**
 * 同一次目录请求的能力、聚合、范围组合子、中文 labels、审批及任务摘要。
 * 目录描述应用支持什么，不代表当前角色已被授予全部能力。
 */
export interface Catalog {
  capabilities: Capability[];
  aggregates: Aggregate[];
  combinators: string[];
  labels: Record<string, string>;
  approvals: { name: string; process: string; aggregate: string; label: string }[];
  /** 应用是否导出审批运营运行时；兼容旧服务端时缺省表示未启用，不尝试不存在的接口。 */
  approvalOperations?: boolean;
  jobs: { name: string; label: string }[];
}
/**
 * 分页读取的展示子集：items 是本页记录，total 是服务器返回总数，二者不能混用为完整集合。
 */
export interface List<T> {
  items: T[];
  total: number;
}
/**
 * self 本人、dept 本部门、deptSubtree 本部门与下级、deptSet 指定部门集合、all 当前租户全部。
 */
export type ScopeKind = 'self' | 'dept' | 'deptSubtree' | 'deptSet' | 'all';
/**
 * 角色读侧快照。capabilities 中 params=null 表示无附加参数；scopes 按聚合设置，
 * deptIds 只对指定部门集合有意义。status 决定是否允许继续编辑，ID 用于命令定位。
 */
export interface Role {
  id: string;
  name: string;
  code: string;
  status: string;
  capabilities: { capability: string; params: Record<string, unknown> | null }[];
  scopes: { aggregate: string; combinator: ScopeKind; deptIds?: string[] | null }[];
}
/**
 * 部门读侧摘要。code/leaderId 可空，ancestors 为包含自身的 ID 路径，页面据此缩进显示层级。
 * 展示类型不提供移动部门操作；负责人选择与给用户授予审批权限是两件事。
 */
export interface Dept {
  id: string;
  name: string;
  code: string | null;
  leaderId: string | null;
  ancestors: string;
  status: string;
}
/**
 * 用户读侧摘要，deptId 为所属部门，roleIds 为当前分配角色集合。
 * 展示值以安全接口返回为准，结构不包含密码哈希；active/disabled 的使用规则由服务端状态机执行。
 */
export interface User {
  id: string;
  username: string;
  name: string;
  deptId: string;
  roleIds: string[];
  status: string;
}
