// 运行协议的持久证据独立于业务聚合；追加系统迁移，保留已发布迁移校验和。
/**
 * connector_execution 用租户/操作/幂等键唯一标识外部执行，保存请求摘要、租约和成功回执。
 * unknown 表示远端是否执行无法确定，不能按普通失败直接重发；worker_runtime 则保存进程指纹与心跳。
 * SQL 字符串是已发布迁移内容，任何后续结构变化必须追加新迁移，不能修改此历史文本。
 */
export const RUNTIME_MIGRATION = {
  name: 'cage:0003_runtime_reliability',
  sql: `
CREATE TABLE IF NOT EXISTS sys.connector_execution (
  tenant_id uuid NOT NULL,
  connector text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','calling','succeeded','failed','unknown')),
  response jsonb,
  error text,
  attempts int NOT NULL DEFAULT 0,
  outbox_id bigint,
  consumer text,
  lease_token text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS connector_execution_outbox_idx ON sys.connector_execution (tenant_id, outbox_id);
DROP INDEX IF EXISTS sys.sync_record_key_uq;
CREATE UNIQUE INDEX sync_record_key_uq ON sys.sync_record (tenant_id, connector, operation, idempotency_key);
CREATE TABLE IF NOT EXISTS sys.worker_runtime (
  id text PRIMARY KEY,
  pid int NOT NULL,
  registry_fingerprint text NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
`,
};
