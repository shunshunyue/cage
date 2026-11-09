// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery, type TransferTask, type RequestOptions } from '@yss123/cage-client';

/** 采购审批协作名录：读侧快照（敏感字段是按权限掩码后的值） */
export const ApprovalMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  specialty: z.string(),
  status: z.enum(["active", "retired"]),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApprovalMember = z.infer<typeof ApprovalMemberSchema>;
export type ApprovalMemberStatus = ApprovalMember['status'];
export const ApprovalMemberStates = ['active', 'retired'] as const;

/** 命令输入：和后端命令的输入校验完全一致 */
export const ApprovalMemberInputs = {
  create: z.object({ userId: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), displayName: z.unknown(), specialty: z.unknown() }),
  retire: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")) }),
  update: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), displayName: z.unknown(), specialty: z.unknown() }),
};

/** ApprovalMember.create 可能返回的错误码 */
export type ApprovalMemberCreateError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT';
/** ApprovalMember.retire 可能返回的错误码 */
export type ApprovalMemberRetireError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';
/** ApprovalMember.update 可能返回的错误码 */
export type ApprovalMemberUpdateError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'NOT_FOUND';

export type ApprovalMemberSortKey = 'createdAt' | 'updatedAt' | 'userId' | 'displayName' | 'specialty';
export interface ApprovalMemberListParams {
  page?: number;
  pageSize?: number;
  /** 排序：字段名，前面加 - 表示倒序 */
  sort?: ApprovalMemberSortKey | `-${ApprovalMemberSortKey}`;
  /** 可以逗号分隔多个状态 */
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  userId?: string | number | boolean;
  displayName?: string | number | boolean;
  specialty?: string | number | boolean;
}

/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */
export const approvalMember = {
  /** 登记采购审批协作人 */
  create: (input: z.input<typeof ApprovalMemberInputs.create>, options: RequestOptions = {}) => client.post<ApprovalMember, ApprovalMemberCreateError>('/api/approval-member/create', input, options),
  /** 停用采购审批协作名录成员 */
  retire: (id: string, expectedVersion?: number, options: RequestOptions = {}) => client.post<ApprovalMember, ApprovalMemberRetireError>(`/api/approval-member/${encodeURIComponent(id)}/retire`, { expectedVersion }, options),
  /** 修改采购协作人的公开资料 */
  update: (id: string, input: Omit<z.input<typeof ApprovalMemberInputs.update>, 'id'>, expectedVersion?: number, options: RequestOptions = {}) => client.post<ApprovalMember, ApprovalMemberUpdateError>(`/api/approval-member/${encodeURIComponent(id)}/update`, { ...input, expectedVersion }, options),
  /** 异步导出 CSV：返回任务，使用 client.transfer(id) 查状态，完成后下载。需要 ApprovalMember.export 能力。 */
  export: (params: ApprovalMemberListParams = {}, options: RequestOptions = {}) => client.post<TransferTask, 'CONFLICT'>('/api/approval-member/export', params, options),
  get: (id: string, options: RequestOptions = {}) => client.get<ApprovalMember>(`/api/approval-member/${encodeURIComponent(id)}`, undefined, options),
  list: (params: ApprovalMemberListParams = {}, options: RequestOptions = {}) => client.get<{ items: ApprovalMember[]; total: number; page: number; pageSize: number }>('/api/approval-member', params as Record<string, unknown>, options),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const useApprovalMember = (id: string) => useCageQuery(['approval-member', id], `/api/approval-member/${encodeURIComponent(id)}`, ApprovalMemberSchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const useApprovalMemberList = (params: ApprovalMemberListParams = {}) => useCageList(['approval-member'], '/api/approval-member', params as Record<string, unknown>, ApprovalMemberSchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const approvalMemberKeys = { all: ['approval-member'] as const, one: (id: string) => ['approval-member', id] as const };
