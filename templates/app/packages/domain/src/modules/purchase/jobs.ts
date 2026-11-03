// 定时任务只调用显式列出的命令；取消操作和用户操作共用内核及审计。
import { daysAgo, job } from '@yss123/cage-kernel';
import { PurchaseOrder, cancel } from './purchase-order.js';

export const expireStaleOrders = job('expireStaleOrders', {
  cron: '0 2 * * *',
  reads: [PurchaseOrder],
  calls: [cancel],
  run: async ({ query, call }) => {
    const stale = await query.list(PurchaseOrder, { status: 'draft', createdBefore: daysAgo(30) });
    for (const po of stale) await call(cancel, { id: po.id });
  },
});
