// 跨聚合资源配对：审批时同事务建锁，取消/收货时通过 outbox 释放。
// acquires/releases 供图规则检查；map 返回 null 表示该次事件没有需要释放的资源。
import { reaction } from '@yss123/cage-kernel';
import { OrderApproved, OrderCancelled, OrderReceived } from './purchase-order.js';
import { acquireLock, releaseLock } from './inventory.js';

export const lockOnApprove = reaction(OrderApproved, {
  command: acquireLock,
  tx: 'same',
  acquires: 'inventory.lock',
  map: (e) => ({ id: e.orderId, orderId: e.orderId, items: e.items }),
});

export const releaseOnCancel = reaction(OrderCancelled, {
  command: releaseLock,
  releases: 'inventory.lock',
  map: (e) => (e.previousStatus === 'approved' ? { id: e.orderId } : null),
});

export const releaseOnReceive = reaction(OrderReceived, {
  command: releaseLock,
  releases: 'inventory.lock',
  map: (e) => ({ id: e.orderId }),
});
