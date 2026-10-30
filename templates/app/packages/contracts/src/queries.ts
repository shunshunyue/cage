// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

import { z } from 'zod';
import { client, useCageQuery } from '@yss123/cage-client';

/** 查询输入 */
export const QueryInputs = {
  poByStatus: z.object({ status: z.string() }),
};

export const queries = {
  /** poByStatus（需要 PurchaseOrder.read） */
  poByStatus: (input: z.input<typeof QueryInputs.poByStatus> = {} as any) => client.get<Record<string, unknown>[]>('/api/queries/po-by-status', input as Record<string, unknown>),
};

export const usePoByStatus = (input: z.input<typeof QueryInputs.poByStatus> = {} as any) => useCageQuery<Record<string, unknown>[]>(['query', 'poByStatus'], '/api/queries/po-by-status', undefined, { query: input as Record<string, unknown> });
