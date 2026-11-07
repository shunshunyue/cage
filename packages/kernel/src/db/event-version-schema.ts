/** 提交版本属于事件执行证据；追加迁移，不重写已发布的 outbox 表定义。 */
export const EVENT_VERSION_MIGRATION = {
  name: 'cage:0005_event_version',
  sql: 'ALTER TABLE sys.outbox ADD COLUMN aggregate_version integer;',
};
