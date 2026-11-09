/**
 * 向应用 domain 暴露可注册的组织聚合与命令。
 * 这里仅组合声明，不执行初始化、不连接数据库；实际写入仍由内核按能力、范围和状态检查。
 * 密码计算辅助函数没有作为领域声明重导出，避免把实现工具误当成可执行业务能力。
 */
// @yss123/cage-admin/domain：框架自带的组织模型声明。业务 domain 的 index.ts 里写一行
//   export * from '@yss123/cage-admin/domain';
// 抽取器、内核、HTTP 层就都能看到部门、用户、角色。
export {
  Dept, User, Role,
  createDept, updateDept, archiveDept,
  createUser, updateUser, assignRoles, disableUser, enableUser, setPassword,
  createRole, renameRole, grantCapability, revokeCapability, setScope, archiveRole,
} from './org.js';
