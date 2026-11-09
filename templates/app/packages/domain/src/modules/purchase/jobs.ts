// 定时任务只调用显式列出的命令；取消操作和用户操作共用内核及审计。
import { daysAgo, job } from '@yss123/cage-kernel';
import { PurchaseOrder, cancel } from './purchase-order.js';

/**
 * 每日 02:00 候选周期清理创建超过三十天且仍为 draft 的单据，时间解释沿用 worker 调度器环境。
 * reads/calls 是实际运行白名单；查询默认批次上限为 1000，逐条取消各自经过独立命令事务。
 * 已成功取消的单据不会再次匹配 draft；中途失败保留已提交进度，不能把本轮任务视为整体回滚。
 */
export const expireStaleOrders = job('expireStaleOrders', {
  cron: '0 2 * * *',
  reads: [PurchaseOrder],
  calls: [cancel],
  run: async ({ query, call }) => {
    const stale = await query.list(PurchaseOrder, { status: 'draft', createdBefore: daysAgo(30) });
    for (const po of stale) await call(cancel, { id: po.id });
  },
});
