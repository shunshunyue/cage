// 独立的前向系统迁移；不改动已发布的 cage:0001_system 校验和。
// 文件与任务存在同一 PostgreSQL 中，API/worker 不需要共享本地磁盘。
// 原始文件和结果仅保留 24 小时；索引记录保留用于幂等及操作追踪。
export const TRANSFER_MIGRATION = {
  name: 'cage:0002_data_transfer',
  sql: `
CREATE TABLE sys.data_transfer (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export', 'import')),
  target text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  input jsonb,
  status text NOT NULL DEFAULT 'queued',
  outbox_id bigint NOT NULL REFERENCES sys.outbox(id),
  result jsonb,
  file_body text,
  access_hash text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (tenant_id, user_id, idempotency_key)
);
CREATE INDEX data_transfer_owner_idx ON sys.data_transfer (tenant_id, user_id, created_at DESC);
CREATE INDEX data_transfer_expiry_idx ON sys.data_transfer (expires_at) WHERE status <> 'expired';
`,
};
