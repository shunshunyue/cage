// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery, type TransferTask, type RequestOptions } from '@yss123/cage-client';

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
  assignRoles: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), roleIds: z.array(z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"))).max(50) }),
  create: z.object({ username: z.string().min(2).max(64).regex(new RegExp("^[A-Za-z0-9_.@-]+$")), name: z.string().min(1).max(100), deptId: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), phone: z.string().max(32).nullable().optional(), email: z.string().email().max(200).nullable().optional(), ssoSubject: z.string().max(200).nullable().optional() }),
  disable: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")) }),
  enable: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")) }),
  setPassword: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), password: z.string().min(8).max(200) }),
  update: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), name: z.string().min(1).max(100).optional(), deptId: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")).optional(), phone: z.string().max(32).nullable().optional(), email: z.string().email().max(200).nullable().optional() }),
};

/** User.assignRoles 可能返回的错误码 */
export type UserAssignRolesError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** User.create 可能返回的错误码 */
export type UserCreateError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT';
/** User.disable 可能返回的错误码 */
export type UserDisableError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** User.enable 可能返回的错误码 */
export type UserEnableError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** User.setPassword 可能返回的错误码 */
export type UserSetPasswordError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
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
  assignRoles: (id: string, input: Omit<z.input<typeof UserInputs.assignRoles>, 'id'>, expectedVersion?: number, options: RequestOptions = {}) => client.post<User, UserAssignRolesError>(`/api/user/${encodeURIComponent(id)}/assign-roles`, { ...input, expectedVersion }, options),
  /** 新建用户（默认没有任何角色） */
  create: (input: z.input<typeof UserInputs.create>, options: RequestOptions = {}) => client.post<User, UserCreateError>('/api/user/create', input, options),
  /** 停用用户 */
  disable: (id: string, expectedVersion?: number, options: RequestOptions = {}) => client.post<User, UserDisableError>(`/api/user/${encodeURIComponent(id)}/disable`, { expectedVersion }, options),
  /** 启用用户 */
  enable: (id: string, expectedVersion?: number, options: RequestOptions = {}) => client.post<User, UserEnableError>(`/api/user/${encodeURIComponent(id)}/enable`, { expectedVersion }, options),
  /** 重置密码 */
  setPassword: (id: string, input: Omit<z.input<typeof UserInputs.setPassword>, 'id'>, expectedVersion?: number, options: RequestOptions = {}) => client.post<User, UserSetPasswordError>(`/api/user/${encodeURIComponent(id)}/set-password`, { ...input, expectedVersion }, options),
  /** 修改用户信息 */
  update: (id: string, input: Omit<z.input<typeof UserInputs.update>, 'id'>, expectedVersion?: number, options: RequestOptions = {}) => client.post<User, UserUpdateError>(`/api/user/${encodeURIComponent(id)}/update`, { ...input, expectedVersion }, options),
  /** 异步导出 CSV：返回任务，使用 client.transfer(id) 查状态，完成后下载。需要 User.export 能力。 */
  export: (params: UserListParams = {}, options: RequestOptions = {}) => client.post<TransferTask, 'CONFLICT'>('/api/user/export', params, options),
  get: (id: string, options: RequestOptions = {}) => client.get<User>(`/api/user/${encodeURIComponent(id)}`, undefined, options),
  list: (params: UserListParams = {}, options: RequestOptions = {}) => client.get<{ items: User[]; total: number; page: number; pageSize: number }>('/api/user', params as Record<string, unknown>, options),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const useUser = (id: string) => useCageQuery(['user', id], `/api/user/${encodeURIComponent(id)}`, UserSchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const useUserList = (params: UserListParams = {}) => useCageList(['user'], '/api/user', params as Record<string, unknown>, UserSchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const userKeys = { all: ['user'] as const, one: (id: string) => ['user', id] as const };
