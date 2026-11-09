// CLI、API 与 worker 共用这个领域入口。空白项目只注册组织基础模型，
// 不注册采购示例；新增业务写在 modules/<业务>，跨模块流程和外部集成分别放 workflows、integrations，再统一导出。
// 完整采购代码保存在 docs/examples/purchase-admin，仅作离线参考。
// 未导出的声明不参与注册、生成或事件消费；本入口只组合声明，不做数据库初始化与网络访问。
export * from '@yss123/cage-admin/domain';
