// 最简聚合示例：Inventory 维护物料台账，InventoryLock 记录订单的资源占用。
// 此范例验证锁的生命周期；available 是登记数量，不包含仓库出入库核算。
import { aggregate, command, id, int, list, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

/**
 * SKU 台账：sku 为租户内唯一物料编码，available 为登记的整数件数。
 * scope.none 表示不提供部门/创建人范围字段，访问仍需要相应能力，并继续受租户隔离。
 * 范例没有出入库命令或自动扣减，不能把此台账当作完整库存会计系统。
 */
export const Inventory = aggregate('Inventory', {
  fields: { sku: text(64).unique(), available: int() },
  scope: scope.none(),
});

/** 登记物料的初始数量，使用默认聚合 active 状态；唯一编码和字段类型由写流水线校验。 */
export const createInventory = command(Inventory, {
  name: 'create',
  from: 'new',
  to: 'active',
  input: z.object({ sku: z.string(), available: z.number().int() }),
  handler: (o) => o,
});

/**
 * 一张采购单对应一个占用记录：orderId 保存来源，items 保存批准时的物料与整数件数快照。
 * held 表示仍占用，released 保留历史并结束生命周期；释放改变状态，不物理删除审计对象。
 */
export const InventoryLock = aggregate('InventoryLock', {
  fields: { orderId: id(), items: list({ sku: text(64), qty: int() }) },
  states: states('held', 'released', { terminal: ['released'] }),
  scope: scope.none(),
});

// 锁以订单 id 为主键，同一事务反应确保审批和建锁一起成功或回滚。
const itemsInput = z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1);

/** 由流程创建 held 记录；工作流把 id 与 orderId 都设为采购单 ID，确保释放可直接定位同一占用。 */
export const acquireLock = command(InventoryLock, {
  name: 'acquire',
  from: 'new',
  to: 'held',
  invokedBy: 'process',
  input: z.object({ id: z.string().uuid(), orderId: z.string().uuid(), items: itemsInput }),
  handler: (o) => o,
});

/** 仅流程可将 held 改为 released；重复事件是否回放由外层幂等处理，不能任意从终态再释放。 */
export const releaseLock = command(InventoryLock, {
  name: 'release',
  from: 'held',
  to: 'released',
  invokedBy: 'process',
  handler: (o) => o,
});
