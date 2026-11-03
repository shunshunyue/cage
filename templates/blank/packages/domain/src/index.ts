// CLI、API 与 worker 共用这个领域入口。空白项目只注册组织基础模型，
// 不注册采购示例；新增业务写在同目录的 .ts 文件，再从这里统一导出。
// 完整采购代码保存在 docs/examples/purchase-admin，仅作离线参考。
export * from '@yss123/cage-admin/domain';
