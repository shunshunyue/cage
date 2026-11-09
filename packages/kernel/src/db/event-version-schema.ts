/** 提交版本属于事件执行证据；追加迁移，不重写已发布的 outbox 表定义。 */
/**
 * aggregate_version 允许时间线将事件对应到实际提交版本；历史事件没有值时仍可正常消费。
 * 不回填猜测版本，避免把当前对象版本错误归因于旧事件；迁移 SQL 作为历史保持不可变。
 */
export const EVENT_VERSION_MIGRATION = {
  name: 'cage:0005_event_version',
  sql: 'ALTER TABLE sys.outbox ADD COLUMN aggregate_version integer;',
};
