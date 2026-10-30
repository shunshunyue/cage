// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery } from '@yss123/cage-client';

/** InventoryLock：读侧快照（敏感字段是按权限掩码后的值） */
export const InventoryLockSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  items: z.array(z.object({ sku: z.string(), qty: z.number().int() })),
  status: z.enum(["held", "released"]),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InventoryLock = z.infer<typeof InventoryLockSchema>;
export type InventoryLockStatus = InventoryLock['status'];
export const InventoryLockStates = ['held', 'released'] as const;

/** 命令输入：和后端命令的输入校验完全一致 */
export const InventoryLockInputs = {
};


export type InventoryLockSortKey = 'createdAt' | 'updatedAt' | 'orderId';
export interface InventoryLockListParams {
  page?: number;
  pageSize?: number;
  /** 排序：字段名，前面加 - 表示倒序 */
  sort?: InventoryLockSortKey | `-${InventoryLockSortKey}`;
  /** 可以逗号分隔多个状态 */
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  orderId?: string | number | boolean;
}

/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */
export const inventoryLock = {
  /** 导出 CSV：需要 InventoryLock.export 能力 */
  export: (params: InventoryLockListParams = {}) => client.post<string, never>('/api/inventory-lock/export', params),
  get: (id: string) => client.get<InventoryLock>(`/api/inventory-lock/${encodeURIComponent(id)}`),
  list: (params: InventoryLockListParams = {}) => client.get<{ items: InventoryLock[]; total: number; page: number; pageSize: number }>('/api/inventory-lock', params as Record<string, unknown>),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const useInventoryLock = (id: string) => useCageQuery(['inventory-lock', id], `/api/inventory-lock/${encodeURIComponent(id)}`, InventoryLockSchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const useInventoryLockList = (params: InventoryLockListParams = {}) => useCageList(['inventory-lock'], '/api/inventory-lock', params as Record<string, unknown>, InventoryLockSchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const inventoryLockKeys = { all: ['inventory-lock'] as const, one: (id: string) => ['inventory-lock', id] as const };
