// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

export * from './dept';
export * from './inventory';
export * from './inventory-lock';
export * from './purchase-order';
export * from './role';
export * from './user';
export * from './queries';
import { can as baseCan, useCan as baseUseCan } from '@yss123/cage-client';
import { DeptInputs } from './dept';
import { InventoryInputs } from './inventory';
import { InventoryLockInputs } from './inventory-lock';
import { PurchaseOrderInputs } from './purchase-order';
import { RoleInputs } from './role';
import { UserInputs } from './user';
export { client, configureClient, loadMe, currentUser, CageQueryError, type CageResult, type CommonError } from '@yss123/cage-client';

/** 能力目录（由代码派生）：写错能力点名会编译失败 */
export const capabilities = [
  'Dept.archive',
  'Dept.create',
  'Dept.export',
  'Dept.read',
  'Dept.update',
  'Inventory.create',
  'Inventory.export',
  'Inventory.read',
  'InventoryLock.acquire',
  'InventoryLock.export',
  'InventoryLock.read',
  'InventoryLock.release',
  'PurchaseOrder.approve',
  'PurchaseOrder.cancel',
  'PurchaseOrder.create',
  'PurchaseOrder.export',
  'PurchaseOrder.markReceived',
  'PurchaseOrder.read',
  'PurchaseOrder.recordErpNo',
  'PurchaseOrder.reject',
  'PurchaseOrder.submit',
  'PurchaseOrder.unmask.phone',
  'Role.archive',
  'Role.create',
  'Role.export',
  'Role.grantCapability',
  'Role.read',
  'Role.rename',
  'Role.revokeCapability',
  'Role.setScope',
  'Sys.audit.read',
  'Sys.ops.manage',
  'Sys.ops.read',
  'User.assignRoles',
  'User.create',
  'User.disable',
  'User.enable',
  'User.export',
  'User.read',
  'User.setPassword',
  'User.unmask.email',
  'User.unmask.name',
  'User.unmask.phone',
  'User.update',
] as const;
export type Capability = (typeof capabilities)[number];

/** 当前用户有没有某个能力点。只影响界面显示：绕过前端直接调接口，内核一样会拒绝 */
export const can = (capability: Capability): boolean => baseCan(capability);
export const useCan = (capability: Capability): boolean => baseUseCan(capability);

/** 各聚合的命令输入 schema：schemas.PurchaseOrder.create 可以直接给表单库做校验 */
export const schemas = {
  Dept: DeptInputs,
  Inventory: InventoryInputs,
  InventoryLock: InventoryLockInputs,
  PurchaseOrder: PurchaseOrderInputs,
  Role: RoleInputs,
  User: UserInputs,
};
