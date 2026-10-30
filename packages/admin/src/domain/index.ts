// @yss123/cage-admin/domain：框架自带的组织模型声明。业务 domain 的 index.ts 里写一行
//   export * from '@yss123/cage-admin/domain';
// 抽取器、内核、HTTP 层就都能看到部门、用户、角色。
export {
  Dept, User, Role,
  createDept, updateDept, archiveDept,
  createUser, updateUser, assignRoles, disableUser, enableUser, setPassword,
  createRole, renameRole, grantCapability, revokeCapability, setScope, archiveRole,
} from './org.js';
