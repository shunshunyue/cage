// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery, type TransferTask, type RequestOptions } from '@yss123/cage-client';

/** 部门：读侧快照（敏感字段是按权限掩码后的值） */
export const DeptSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  ancestors: z.string(),
  leaderId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "archived"]),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Dept = z.infer<typeof DeptSchema>;
export type DeptStatus = Dept['status'];
export const DeptStates = ['active', 'archived'] as const;

/** 命令输入：和后端命令的输入校验完全一致 */
export const DeptInputs = {
  archive: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")) }),
  create: z.object({ name: z.string().min(1).max(100), code: z.string().max(64).optional(), parentId: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")).nullable().optional(), leaderId: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")).nullable().optional() }),
  update: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), name: z.string().min(1).max(100).optional(), code: z.string().max(64).nullable().optional(), leaderId: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")).nullable().optional() }),
};

/** Dept.archive 可能返回的错误码 */
export type DeptArchiveError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** Dept.create 可能返回的错误码 */
export type DeptCreateError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT';
/** Dept.update 可能返回的错误码 */
export type DeptUpdateError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';

export type DeptSortKey = 'createdAt' | 'updatedAt' | 'name' | 'code' | 'parentId' | 'ancestors' | 'leaderId';
export interface DeptListParams {
  page?: number;
  pageSize?: number;
  /** 排序：字段名，前面加 - 表示倒序 */
  sort?: DeptSortKey | `-${DeptSortKey}`;
  /** 可以逗号分隔多个状态 */
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  name?: string | number | boolean;
  code?: string | number | boolean;
  parentId?: string | number | boolean;
  ancestors?: string | number | boolean;
  leaderId?: string | number | boolean;
}

/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */
export const dept = {
  /** 停用部门（没有在职用户和下级部门时） */
  archive: (id: string, expectedVersion?: number, options: RequestOptions = {}) => client.post<Dept, DeptArchiveError>(`/api/dept/${encodeURIComponent(id)}/archive`, { expectedVersion }, options),
  /** 新建部门 */
  create: (input: z.input<typeof DeptInputs.create>, options: RequestOptions = {}) => client.post<Dept, DeptCreateError>('/api/dept/create', input, options),
  /** 修改部门名称、编码、负责人 */
  update: (id: string, input: Omit<z.input<typeof DeptInputs.update>, 'id'>, expectedVersion?: number, options: RequestOptions = {}) => client.post<Dept, DeptUpdateError>(`/api/dept/${encodeURIComponent(id)}/update`, { ...input, expectedVersion }, options),
  /** 异步导出 CSV：返回任务，使用 client.transfer(id) 查状态，完成后下载。需要 Dept.export 能力。 */
  export: (params: DeptListParams = {}, options: RequestOptions = {}) => client.post<TransferTask, 'CONFLICT'>('/api/dept/export', params, options),
  get: (id: string, options: RequestOptions = {}) => client.get<Dept>(`/api/dept/${encodeURIComponent(id)}`, undefined, options),
  list: (params: DeptListParams = {}, options: RequestOptions = {}) => client.get<{ items: Dept[]; total: number; page: number; pageSize: number }>('/api/dept', params as Record<string, unknown>, options),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const useDept = (id: string) => useCageQuery(['dept', id], `/api/dept/${encodeURIComponent(id)}`, DeptSchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const useDeptList = (params: DeptListParams = {}) => useCageList(['dept'], '/api/dept', params as Record<string, unknown>, DeptSchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const deptKeys = { all: ['dept'] as const, one: (id: string) => ['dept', id] as const };
