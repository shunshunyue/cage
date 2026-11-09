// 跨聚合资源配对：审批时同事务建锁，取消/收货时通过 outbox 释放。
// acquires/releases 供图规则检查；map 返回 null 表示该次事件没有需要释放的资源。
import { reaction } from '@yss123/cage-kernel';
import { OrderApproved, OrderCancelled, OrderReceived } from '../modules/purchase/index.js';
import { acquireLock, releaseLock } from '../modules/inventory/index.js';

/**
 * 审批与建锁共用一笔数据库事务，任一命令失败则二者回滚；不会出现批准成功但没有锁的中间提交。
 * acquires 仅供图规则配对，实际写入来自 acquireLock，映射只传当前批准事件的固定快照。
 */
export const lockOnApprove = reaction(OrderApproved, {
  command: acquireLock,
  tx: 'same',
  acquires: 'inventory.lock',
  map: (e) => ({ id: e.orderId, orderId: e.orderId, items: e.items }),
});

/** 草稿/待审批取消从未建锁，返回 null 跳过；已批准取消进入 outbox，等待 worker 按单据顺序释放。 */
export const releaseOnCancel = reaction(OrderCancelled, {
  command: releaseLock,
  releases: 'inventory.lock',
  map: (e) => (e.previousStatus === 'approved' ? { id: e.orderId } : null),
});

/** 收货事件保证来自已批准单据，因此按订单 ID 释放；默认异步失败由 worker 重试/死信处理。 */
export const releaseOnReceive = reaction(OrderReceived, {
  command: releaseLock,
  releases: 'inventory.lock',
  map: (e) => ({ id: e.orderId }),
});
