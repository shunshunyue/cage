// 生成物：由 cage gen 从 domain 声明生成，不要手改。
/* eslint-disable */

export * from './aggregates/dept';
export * from './aggregates/role';
export * from './aggregates/user';
export * from './queries';
import { can as baseCan, useCan as baseUseCan } from '@yss123/cage-client';
import { DeptInputs } from './aggregates/dept';
import { RoleInputs } from './aggregates/role';
import { UserInputs } from './aggregates/user';
export { client, configureClient, loadMe, currentUser, CageQueryError, useTransfer, type CageResult, type CommonError, type TransferTask, type ImportReport } from '@yss123/cage-client';

/** 能力目录（由代码派生）：写错能力点名会编译失败 */
export const capabilities = [
  'Dept.archive',
  'Dept.create',
  'Dept.export',
  'Dept.read',
  'Dept.update',
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

/** 各聚合的命令输入 schema：按聚合名、命令名访问，可直接供表单库校验 */
export const schemas = {
  Dept: DeptInputs,
  Role: RoleInputs,
  User: UserInputs,
};
