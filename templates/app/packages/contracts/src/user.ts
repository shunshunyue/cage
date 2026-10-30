// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery } from '@yss123/cage-client';

/** 用户：读侧快照（敏感字段是按权限掩码后的值） */
export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  name: z.string(),
  deptId: z.string().uuid(),
  roleIds: z.array(z.string().uuid()),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  ssoSubject: z.string().nullable().optional(),
  status: z.enum(["active", "disabled"]),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;
export type UserStatus = User['status'];
export const UserStates = ['active', 'disabled'] as const;

/** 命令输入：和后端命令的输入校验完全一致 */
export const UserInputs = {
  assignRoles: z.object({ id: z.string().uuid(), roleIds: z.array(z.string().uuid()).max(50) }),
  create: z.object({ username: z.string().min(2).max(64).regex(new RegExp("^[A-Za-z0-9_.@-]+$")), name: z.string().min(1).max(100), deptId: z.string().uuid(), phone: z.string().max(32).nullable().optional(), email: z.string().email().max(200).nullable().optional(), ssoSubject: z.string().max(200).nullable().optional() }),
  disable: z.object({ id: z.string().uuid() }),
  enable: z.object({ id: z.string().uuid() }),
  setPassword: z.object({ id: z.string().uuid(), password: z.string().min(8).max(200) }),
  update: z.object({ id: z.string().uuid(), name: z.string().min(1).max(100).optional(), deptId: z.string().uuid().optional(), phone: z.string().max(32).nullable().optional(), email: z.string().email().max(200).nullable().optional() }),
};

/** User.assignRoles 可能返回的错误码 */
export type UserAssignRolesError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** User.create 可能返回的错误码 */
export type UserCreateError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT';
/** User.disable 可能返回的错误码 */
export type UserDisableError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** User.enable 可能返回的错误码 */
export type UserEnableError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** User.setPassword 可能返回的错误码 */
export type UserSetPasswordError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** User.update 可能返回的错误码 */
export type UserUpdateError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';

export type UserSortKey = 'createdAt' | 'updatedAt' | 'username' | 'name' | 'deptId' | 'phone' | 'email' | 'ssoSubject';
export interface UserListParams {
  page?: number;
  pageSize?: number;
  /** 排序：字段名，前面加 - 表示倒序 */
  sort?: UserSortKey | `-${UserSortKey}`;
  /** 可以逗号分隔多个状态 */
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  username?: string | number | boolean;
  deptId?: string | number | boolean;
  ssoSubject?: string | number | boolean;
}

/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */
export const user = {
  /** 设置用户的角色（不能分配包含自己没有的能力的角色） */
  assignRoles: (id: string, input: Omit<z.input<typeof UserInputs.assignRoles>, 'id'>, expectedVersion?: number) => client.post<User, UserAssignRolesError>(`/api/user/${encodeURIComponent(id)}/assign-roles`, { ...input, expectedVersion }),
  /** 新建用户（默认没有任何角色） */
  create: (input: z.input<typeof UserInputs.create>) => client.post<User, UserCreateError>('/api/user/create', input),
  /** 停用用户 */
  disable: (id: string, expectedVersion?: number) => client.post<User, UserDisableError>(`/api/user/${encodeURIComponent(id)}/disable`, { expectedVersion }),
  /** 启用用户 */
  enable: (id: string, expectedVersion?: number) => client.post<User, UserEnableError>(`/api/user/${encodeURIComponent(id)}/enable`, { expectedVersion }),
  /** 重置密码 */
  setPassword: (id: string, input: Omit<z.input<typeof UserInputs.setPassword>, 'id'>, expectedVersion?: number) => client.post<User, UserSetPasswordError>(`/api/user/${encodeURIComponent(id)}/set-password`, { ...input, expectedVersion }),
  /** 修改用户信息 */
  update: (id: string, input: Omit<z.input<typeof UserInputs.update>, 'id'>, expectedVersion?: number) => client.post<User, UserUpdateError>(`/api/user/${encodeURIComponent(id)}/update`, { ...input, expectedVersion }),
  /** 导出 CSV：需要 User.export 能力 */
  export: (params: UserListParams = {}) => client.post<string, never>('/api/user/export', params),
  get: (id: string) => client.get<User>(`/api/user/${encodeURIComponent(id)}`),
  list: (params: UserListParams = {}) => client.get<{ items: User[]; total: number; page: number; pageSize: number }>('/api/user', params as Record<string, unknown>),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const useUser = (id: string) => useCageQuery(['user', id], `/api/user/${encodeURIComponent(id)}`, UserSchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const useUserList = (params: UserListParams = {}) => useCageList(['user'], '/api/user', params as Record<string, unknown>, UserSchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const userKeys = { all: ['user'] as const, one: (id: string) => ['user', id] as const };
