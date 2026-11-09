// 追加系统迁移，文件字节不进入数据库、审计或 outbox。
/**
 * 上传会话记录用户、目标命令/字段、字节政策和幂等摘要；bound 与 bound_id 的约束固定文件归属。
 * 分片由 upload_id/number 唯一定位，token/lease_until 解决并发写入和中断恢复，storage_key 指向字节存储。
 * bound 文件不按临时会话过期清理；SQL 是历史迁移，修改结构须追加迁移而非编辑字符串。
 */
export const FILE_MIGRATION = {
  name: 'cage:0004_files',
  sql: `
CREATE TABLE sys.file_upload (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  aggregate_name text NOT NULL,
  field_name text NOT NULL,
  command_name text NOT NULL,
  target_id uuid,
  filename text NOT NULL,
  content_type text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  part_bytes int NOT NULL CHECK (part_bytes > 0),
  part_count int NOT NULL CHECK (part_count > 0),
  storage text NOT NULL,
  storage_key text,
  status text NOT NULL CHECK (status IN ('uploading','completing','ready','bound','deleting','deleted')),
  bound_id uuid,
  operation_token uuid,
  lease_until timestamptz,
  pruned_at timestamptz,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (tenant_id, user_id, idempotency_key),
  CHECK ((status = 'bound') = (bound_id IS NOT NULL))
);
CREATE INDEX file_upload_owner_idx ON sys.file_upload(tenant_id, user_id, created_at DESC);
CREATE INDEX file_upload_expiry_idx ON sys.file_upload(expires_at) WHERE status <> 'bound';
CREATE TABLE sys.file_part (
  upload_id uuid NOT NULL REFERENCES sys.file_upload(id),
  number int NOT NULL CHECK (number > 0),
  bytes int NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL,
  token uuid NOT NULL,
  storage_key text,
  lease_until timestamptz,
  PRIMARY KEY (upload_id, number)
);
`,
};
