// 最简聚合示例：Inventory 维护物料台账，InventoryLock 记录订单的资源占用。
// 此范例验证锁的生命周期；available 是登记数量，不包含仓库出入库核算。
import { aggregate, command, id, int, list, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

export const Inventory = aggregate('Inventory', {
  fields: { sku: text(64).unique(), available: int() },
  scope: scope.none(),
});

export const createInventory = command(Inventory, {
  name: 'create',
  from: 'new',
  to: 'active',
  input: z.object({ sku: z.string(), available: z.number().int() }),
  handler: (o) => o,
});

export const InventoryLock = aggregate('InventoryLock', {
  fields: { orderId: id(), items: list({ sku: text(64), qty: int() }) },
  states: states('held', 'released', { terminal: ['released'] }),
  scope: scope.none(),
});

// 锁以订单 id 为主键，同一事务反应确保审批和建锁一起成功或回滚。
const itemsInput = z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1);

export const acquireLock = command(InventoryLock, {
  name: 'acquire',
  from: 'new',
  to: 'held',
  invokedBy: 'process',
  input: z.object({ id: z.string().uuid(), orderId: z.string().uuid(), items: itemsInput }),
  handler: (o) => o,
});

export const releaseLock = command(InventoryLock, {
  name: 'release',
  from: 'held',
  to: 'released',
  invokedBy: 'process',
  handler: (o) => o,
});
