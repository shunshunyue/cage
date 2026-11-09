// 查询只能读取安全视图；命名参数由运行时绑定，不拼接用户输入。
import { query } from '@yss123/cage-kernel';
import { z } from 'zod';
import { PurchaseOrder } from './purchase-order.js';

/**
 * 按指定状态统计当前调用者可见采购单的部门分布，结果为 dept_id 与整数 n。
 * reads 声明触发 PurchaseOrder.read 检查；safe.purchase_order 继续执行租户和数据范围过滤。
 * :status 由内核绑定为参数，结果不代表跨权限的全公司统计；本声明没有业务写入副作用。
 */
export const poByStatus = query('poByStatus', {
  reads: [PurchaseOrder],
  input: z.object({ status: z.string() }),
  sql: `select dept_id, count(*)::int as n from safe.purchase_order where status = :status group by dept_id`,
});
