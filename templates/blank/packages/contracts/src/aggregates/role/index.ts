// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery, type TransferTask } from '@yss123/cage-client';

/** 角色：读侧快照（敏感字段是按权限掩码后的值） */
export const RoleSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  capabilities: z.array(z.object({ capability: z.string(), params: z.record(z.string(), z.unknown()).nullable().optional() })),
  scopes: z.array(z.object({ aggregate: z.string(), combinator: z.enum(["all", "self", "dept", "deptSubtree", "deptSet"]), deptIds: z.array(z.string().uuid()).nullable().optional() })),
  status: z.enum(["active", "archived"]),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Role = z.infer<typeof RoleSchema>;
export type RoleStatus = Role['status'];
export const RoleStates = ['active', 'archived'] as const;

/** 命令输入：和后端命令的输入校验完全一致 */
export const RoleInputs = {
  archive: z.object({ id: z.string().uuid() }),
  create: z.object({ code: z.string().min(1).max(64).regex(new RegExp("^[a-z][a-z0-9_]*$")), name: z.string().min(1).max(100) }),
  grantCapability: z.object({ id: z.string().uuid(), capability: z.string().min(1).max(200), params: z.record(z.string(), z.unknown()).optional() }),
  rename: z.object({ id: z.string().uuid(), name: z.string().min(1).max(100) }),
  revokeCapability: z.object({ id: z.string().uuid(), capability: z.string().min(1).max(200) }),
  setScope: z.object({ id: z.string().uuid(), aggregate: z.string().min(1).max(100), combinator: z.enum(["all", "self", "dept", "deptSubtree", "deptSet"]).nullable(), deptIds: z.array(z.string().uuid()).optional() }),
};

/** Role.archive 可能返回的错误码 */
export type RoleArchiveError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** Role.create 可能返回的错误码 */
export type RoleCreateError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT';
/** Role.grantCapability 可能返回的错误码 */
export type RoleGrantCapabilityError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** Role.rename 可能返回的错误码 */
export type RoleRenameError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** Role.revokeCapability 可能返回的错误码 */
export type RoleRevokeCapabilityError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** Role.setScope 可能返回的错误码 */
export type RoleSetScopeError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';

export type RoleSortKey = 'createdAt' | 'updatedAt' | 'code' | 'name';
export interface RoleListParams {
  page?: number;
  pageSize?: number;
  /** 排序：字段名，前面加 - 表示倒序 */
  sort?: RoleSortKey | `-${RoleSortKey}`;
  /** 可以逗号分隔多个状态 */
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  code?: string | number | boolean;
  name?: string | number | boolean;
}

/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */
export const role = {
  /** 停用角色 */
  archive: (id: string, expectedVersion?: number) => client.post<Role, RoleArchiveError>(`/api/role/${encodeURIComponent(id)}/archive`, { expectedVersion }),
  /** 新建角色（默认没有任何能力） */
  create: (input: z.input<typeof RoleInputs.create>) => client.post<Role, RoleCreateError>('/api/role/create', input),
  /** 给角色授予能力点（不能授出自己没有的能力点） */
  grantCapability: (id: string, input: Omit<z.input<typeof RoleInputs.grantCapability>, 'id'>, expectedVersion?: number) => client.post<Role, RoleGrantCapabilityError>(`/api/role/${encodeURIComponent(id)}/grant-capability`, { ...input, expectedVersion }),
  /** 修改角色名称 */
  rename: (id: string, input: Omit<z.input<typeof RoleInputs.rename>, 'id'>, expectedVersion?: number) => client.post<Role, RoleRenameError>(`/api/role/${encodeURIComponent(id)}/rename`, { ...input, expectedVersion }),
  /** 收回角色的能力点 */
  revokeCapability: (id: string, input: Omit<z.input<typeof RoleInputs.revokeCapability>, 'id'>, expectedVersion?: number) => client.post<Role, RoleRevokeCapabilityError>(`/api/role/${encodeURIComponent(id)}/revoke-capability`, { ...input, expectedVersion }),
  /** 设置角色在某个聚合上的数据范围（不能授出比自己更宽的范围） */
  setScope: (id: string, input: Omit<z.input<typeof RoleInputs.setScope>, 'id'>, expectedVersion?: number) => client.post<Role, RoleSetScopeError>(`/api/role/${encodeURIComponent(id)}/set-scope`, { ...input, expectedVersion }),
  /** 异步导出 CSV：返回任务，使用 client.transfer(id) 查状态，完成后下载。需要 Role.export 能力。 */
  export: (params: RoleListParams = {}, options: { idempotencyKey?: string } = {}) => client.post<TransferTask, 'CONFLICT'>('/api/role/export', params, options),
  get: (id: string) => client.get<Role>(`/api/role/${encodeURIComponent(id)}`),
  list: (params: RoleListParams = {}) => client.get<{ items: Role[]; total: number; page: number; pageSize: number }>('/api/role', params as Record<string, unknown>),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const useRole = (id: string) => useCageQuery(['role', id], `/api/role/${encodeURIComponent(id)}`, RoleSchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const useRoleList = (params: RoleListParams = {}) => useCageList(['role'], '/api/role', params as Record<string, unknown>, RoleSchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const roleKeys = { all: ['role'] as const, one: (id: string) => ['role', id] as const };
