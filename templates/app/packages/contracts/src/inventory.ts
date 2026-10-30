// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageList, useCageQuery } from '@yss123/cage-client';

/** Inventory：读侧快照（敏感字段是按权限掩码后的值） */
export const InventorySchema = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  available: z.number().int(),
  status: z.enum(["active", "deleted"]),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Inventory = z.infer<typeof InventorySchema>;
export type InventoryStatus = Inventory['status'];
export const InventoryStates = ['active', 'deleted'] as const;

/** 命令输入：和后端命令的输入校验完全一致 */
export const InventoryInputs = {
  create: z.object({ sku: z.string(), available: z.number().int().min(-9007199254740991).max(9007199254740991) }),
};

/** Inventory.create 可能返回的错误码 */
export type InventoryCreateError = 'CONFLICT' | 'CONSTRAINT_VIOLATED' | 'DOMAIN_ERROR' | 'FORBIDDEN' | 'INVALID_INPUT';

export type InventorySortKey = 'createdAt' | 'updatedAt' | 'sku' | 'available';
export interface InventoryListParams {
  page?: number;
  pageSize?: number;
  /** 排序：字段名，前面加 - 表示倒序 */
  sort?: InventorySortKey | `-${InventorySortKey}`;
  /** 可以逗号分隔多个状态 */
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  sku?: string | number | boolean;
  available?: string | number | boolean;
}

/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */
export const inventory = {
  create: (input: z.input<typeof InventoryInputs.create>) => client.post<Inventory, InventoryCreateError>('/api/inventory/create', input),
  /** 导出 CSV：需要 Inventory.export 能力 */
  export: (params: InventoryListParams = {}) => client.post<string, never>('/api/inventory/export', params),
  get: (id: string) => client.get<Inventory>(`/api/inventory/${encodeURIComponent(id)}`),
  list: (params: InventoryListParams = {}) => client.get<{ items: Inventory[]; total: number; page: number; pageSize: number }>('/api/inventory', params as Record<string, unknown>),
};

/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */
export const useInventory = (id: string) => useCageQuery(['inventory', id], `/api/inventory/${encodeURIComponent(id)}`, InventorySchema, { enabled: !!id });
/** 列表查询 hook：走读侧账号与安全视图 */
export const useInventoryList = (params: InventoryListParams = {}) => useCageList(['inventory'], '/api/inventory', params as Record<string, unknown>, InventorySchema);
/** 查询缓存键前缀：命令成功后让它失效 */
export const inventoryKeys = { all: ['inventory'] as const, one: (id: string) => ['inventory', id] as const };
