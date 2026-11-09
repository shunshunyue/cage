/** 文件包公开入口：协议、默认磁盘实现、上传会话服务分层导出。
 * HTTP 层消费 FileService；扩展对象存储时实现 FileStorage；字段声明和事务内绑定仍由内核负责。
 * 此处只重导出类型与实现，导入模块不会启动清理定时器或创建存储目录。
 */
export * from './storage.js';
export * from './local.js';
export * from './service.js';
