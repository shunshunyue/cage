// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery, type TransferTask, type RequestOptions } from '@yss123/cage-client';

/** PurchaseOrder：读侧快照（敏感字段是按权限掩码后的值） */
export const PurchaseOrderSchema = z.object({
  id: z.string().uuid(),
  deptId: z.string().uuid(),
  createdBy: z.string().uuid(),
  supplierPhone: z.string().nullable().optional(),
  amount: z.string(),
  items: z.array(z.object({ sku: z.string(), qty: z.number().int() })),
  erpNo: z.string().nullable().optional(),
  attachments: z.array(z.string().uuid()).max(10),
  status: z.enum(["draft", "pending_approval", "approved", "received", "rejected", "cancelled"]),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
export type PurchaseOrderStatus = PurchaseOrder['status'];
export const PurchaseOrderStates = ['draft', 'pending_approval', 'approved', 'received', 'rejected', 'cancelled'] as const;
/** 文件字段限制；服务端仍执行权威校验。 */
export const PurchaseOrderFileFields = {"attachments":{"maxBytes":2147483648,"accept":["application/pdf","image/jpeg","image/png","text/plain"],"maxCount":10,"multiple":true}} as const;

/** 命令输入：和后端命令的输入校验完全一致 */
export const PurchaseOrderInputs = {
  cancel: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")) }),
  create: z.object({ amount: z.string(), items: z.array(z.object({ sku: z.string(), qty: z.number().int().max(9007199254740991).gt(0) })).min(1), supplierPhone: z.string().optional(), deptId: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")).optional(), attachments: z.array(z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"))).max(10).optional() }),
  setAttachments: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")), attachments: z.array(z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"))).max(10) }),
  submit: z.object({ id: z.string().uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")) }),
};

/** PurchaseOrder.cancel 可能返回的错误码 */
export type PurchaseOrderCancelError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'INVARIANT_VIOLATED' | 'NOT_FOUND';
/** PurchaseOrder.create 可能返回的错误码 */
export type PurchaseOrderCreateError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVARIANT_VIOLATED' | 'NOT_FOUND';
/** PurchaseOrder.setAttachments 可能返回的错误码 */
export type PurchaseOrderSetAttachmentsError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'INVARIANT_VIOLATED' | 'NOT_FOUND';
/** PurchaseOrder.submit 可能返回的错误码；业务码（domainCode）：NO_ITEMS */
export type PurchaseOrderSubmitError = 'CONFLICT' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'INVARIANT_VIOLATED' | 'NOT_FOUND';
export type PurchaseOrderSubmitDomainCode = 'NO_ITEMS';

export type PurchaseOrderSortKey = 'createdAt' | 'updatedAt' | 'deptId' | 'createdBy' | 'supplierPhone' | 'amount' | 'erpNo';
export interface PurchaseOrderListParams {
  page?: number;
  pageSize?: number;
  /** 排序：字段名，前面加 - 表示倒序 */
  sort?: PurchaseOrderSortKey | `-${PurchaseOrderSortKey}`;
  /** 可以逗号分隔多个状态 */
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  deptId?: string | number | boolean;
  createdBy?: string | number | boolean;
  amount?: string | number | boolean;
  erpNo?: string | number | boolean;
}

/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */
export const purchaseOrder = {
  cancel: (id: string, expectedVersion?: number, options: RequestOptions = {}) => client.post<PurchaseOrder, PurchaseOrderCancelError>(`/api/purchase-order/${encodeURIComponent(id)}/cancel`, { expectedVersion }, options),
  create: (input: z.input<typeof PurchaseOrderInputs.create>, options: RequestOptions = {}) => client.post<PurchaseOrder, PurchaseOrderCreateError>('/api/purchase-order/create', input, options),
  setAttachments: (id: string, input: Omit<z.input<typeof PurchaseOrderInputs.setAttachments>, 'id'>, expectedVersion?: number, options: RequestOptions = {}) => client.post<PurchaseOrder, PurchaseOrderSetAttachmentsError>(`/api/purchase-order/${encodeURIComponent(id)}/set-attachments`, { ...input, expectedVersion }, options),
  submit: (id: string, expectedVersion?: number, options: RequestOptions = {}) => client.post<PurchaseOrder, PurchaseOrderSubmitError>(`/api/purchase-order/${encodeURIComponent(id)}/submit`, { expectedVersion }, options),
  /** 异步导出 CSV：返回任务，使用 client.transfer(id) 查状态，完成后下载。需要 PurchaseOrder.export 能力。 */
  export: (params: PurchaseOrderListParams = {}, options: RequestOptions = {}) => client.post<TransferTask, 'CONFLICT'>('/api/purchase-order/export', params, options),
  get: (id: string, options: RequestOptions = {}) => client.get<PurchaseOrder>(`/api/purchase-order/${encodeURIComponent(id)}`, undefined, options),
  list: (params: PurchaseOrderListParams = {}, options: RequestOptions = {}) => client.get<{ items: PurchaseOrder[]; total: number; page: number; pageSize: number }>('/api/purchase-order', params as Record<string, unknown>, options),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const usePurchaseOrder = (id: string) => useCageQuery(['purchase-order', id], `/api/purchase-order/${encodeURIComponent(id)}`, PurchaseOrderSchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const usePurchaseOrderList = (params: PurchaseOrderListParams = {}) => useCageList(['purchase-order'], '/api/purchase-order', params as Record<string, unknown>, PurchaseOrderSchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const purchaseOrderKeys = { all: ['purchase-order'] as const, one: (id: string) => ['purchase-order', id] as const };
