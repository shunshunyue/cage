// 查询只能读取安全视图；命名参数由运行时绑定，不拼接用户输入。
import { query } from '@yss123/cage-kernel';
import { z } from 'zod';
import { PurchaseOrder } from './purchase-order.js';

export const poByStatus = query('poByStatus', {
  reads: [PurchaseOrder],
  input: z.object({ status: z.string() }),
  sql: `select dept_id, count(*)::int as n from safe.purchase_order where status = :status group by dept_id`,
});
