// @yss123/cage-kernel/db：连接、DDL 生成、迁移执行（cli、testkit、http 使用；业务代码不应导入）
/** 账号连接及生命周期；数据库连接只由基础设施创建，领域 handler 使用注入的只读依赖。 */
export * from './connect.js';
/** 同一注册表推导物理结构和安全视图；SQL 生成本身不连接或修改数据库。 */
export * from './ddl.js';
/** 前向迁移与历史 checksum 校验；调用方须明确选择迁移账号和待执行文件。 */
export * from './migrate.js';
/** 内部行/快照转换与事务会话变量，不能作为业务绕过命令和安全读侧的接口。 */
export * from './rows.js';
export * from './session.js';
