-- 迁移草稿：由 cage gen 生成，人审后提交；已发布的迁移不要修改
-- 破坏性变更按「先扩展再收缩」分多次发布

-- 新表：来自聚合 Inventory
CREATE TABLE IF NOT EXISTS "core"."inventory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "sku" text NOT NULL,
  "available" integer NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_status_check" CHECK (status IN ('active', 'deleted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_sku_uq" ON "core"."inventory" (tenant_id, "sku");
CREATE INDEX IF NOT EXISTS "inventory_status_idx" ON "core"."inventory" ("tenant_id", "status");

-- 新表：来自聚合 InventoryLock
CREATE TABLE IF NOT EXISTS "core"."inventory_lock" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "items" jsonb NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_lock_status_check" CHECK (status IN ('held', 'released'))
);
CREATE INDEX IF NOT EXISTS "inventory_lock_status_idx" ON "core"."inventory_lock" ("tenant_id", "status");

-- 新表：来自聚合 Dept
CREATE TABLE IF NOT EXISTS "sys"."dept" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "code" text,
  "parent_id" uuid REFERENCES "sys"."dept"(id),
  "ancestors" text NOT NULL,
  "leader_id" uuid,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dept_status_check" CHECK (status IN ('active', 'archived'))
);
CREATE INDEX IF NOT EXISTS "dept_status_idx" ON "sys"."dept" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "dept_parent_id_idx" ON "sys"."dept" ("parent_id");

-- 新表：来自聚合 User
CREATE TABLE IF NOT EXISTS "sys"."user" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "username" text NOT NULL,
  "name" text NOT NULL,
  "dept_id" uuid NOT NULL REFERENCES "sys"."dept"(id),
  "role_ids" jsonb NOT NULL,
  "phone" text,
  "email" text,
  "sso_subject" text,
  "password_hash" text,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_status_check" CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_username_uq" ON "sys"."user" (tenant_id, "username");
CREATE INDEX IF NOT EXISTS "user_tenant_dept_id_idx" ON "sys"."user" ("tenant_id", "dept_id");
CREATE INDEX IF NOT EXISTS "user_status_idx" ON "sys"."user" ("tenant_id", "status");

-- 新表：来自聚合 PurchaseOrder
CREATE TABLE IF NOT EXISTS "core"."purchase_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "dept_id" uuid NOT NULL REFERENCES "sys"."dept"(id),
  "created_by" uuid NOT NULL REFERENCES "sys"."user"(id),
  "supplier_phone" text,
  "amount" numeric(18,2) NOT NULL,
  "items" jsonb NOT NULL,
  "erp_no" text,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "purchase_order_status_check" CHECK (status IN ('draft', 'pending_approval', 'approved', 'received', 'rejected', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS "purchase_order_tenant_dept_id_idx" ON "core"."purchase_order" ("tenant_id", "dept_id");
CREATE INDEX IF NOT EXISTS "purchase_order_tenant_created_by_idx" ON "core"."purchase_order" ("tenant_id", "created_by");
CREATE INDEX IF NOT EXISTS "purchase_order_status_idx" ON "core"."purchase_order" ("tenant_id", "status");

-- 新表：来自聚合 Role
CREATE TABLE IF NOT EXISTS "sys"."role" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "capabilities" jsonb NOT NULL,
  "scopes" jsonb NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "role_status_check" CHECK (status IN ('active', 'archived'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "role_code_uq" ON "sys"."role" (tenant_id, "code");
CREATE INDEX IF NOT EXISTS "role_status_idx" ON "sys"."role" ("tenant_id", "status");

/* cage:schema
{"version":1,"tables":[{"schema":"core","name":"inventory","aggregate":"Inventory","columns":[{"name":"id","type":"uuid","notNull":true},{"name":"tenant_id","type":"uuid","notNull":true},{"name":"sku","type":"text","notNull":true,"unique":true},{"name":"available","type":"integer","notNull":true},{"name":"status","type":"text","notNull":true},{"name":"version","type":"integer","notNull":true},{"name":"created_at","type":"timestamptz","notNull":true},{"name":"updated_at","type":"timestamptz","notNull":true}],"statusValues":["active","deleted"],"indexes":[{"name":"inventory_status_idx","columns":["tenant_id","status"]}]},{"schema":"core","name":"inventory_lock","aggregate":"InventoryLock","columns":[{"name":"id","type":"uuid","notNull":true},{"name":"tenant_id","type":"uuid","notNull":true},{"name":"order_id","type":"uuid","notNull":true},{"name":"items","type":"jsonb","notNull":true},{"name":"status","type":"text","notNull":true},{"name":"version","type":"integer","notNull":true},{"name":"created_at","type":"timestamptz","notNull":true},{"name":"updated_at","type":"timestamptz","notNull":true}],"statusValues":["held","released"],"indexes":[{"name":"inventory_lock_status_idx","columns":["tenant_id","status"]}]},{"schema":"sys","name":"dept","aggregate":"Dept","columns":[{"name":"id","type":"uuid","notNull":true},{"name":"tenant_id","type":"uuid","notNull":true},{"name":"name","type":"text","notNull":true},{"name":"code","type":"text","notNull":false},{"name":"parent_id","type":"uuid","notNull":false,"references":"sys.dept"},{"name":"ancestors","type":"text","notNull":true},{"name":"leader_id","type":"uuid","notNull":false},{"name":"status","type":"text","notNull":true},{"name":"version","type":"integer","notNull":true},{"name":"created_at","type":"timestamptz","notNull":true},{"name":"updated_at","type":"timestamptz","notNull":true}],"statusValues":["active","archived"],"indexes":[{"name":"dept_status_idx","columns":["tenant_id","status"]},{"name":"dept_parent_id_idx","columns":["parent_id"]}]},{"schema":"sys","name":"user","aggregate":"User","columns":[{"name":"id","type":"uuid","notNull":true},{"name":"tenant_id","type":"uuid","notNull":true},{"name":"username","type":"text","notNull":true,"unique":true},{"name":"name","type":"text","notNull":true},{"name":"dept_id","type":"uuid","notNull":true,"references":"sys.dept"},{"name":"role_ids","type":"jsonb","notNull":true},{"name":"phone","type":"text","notNull":false},{"name":"email","type":"text","notNull":false},{"name":"sso_subject","type":"text","notNull":false},{"name":"password_hash","type":"text","notNull":false},{"name":"status","type":"text","notNull":true},{"name":"version","type":"integer","notNull":true},{"name":"created_at","type":"timestamptz","notNull":true},{"name":"updated_at","type":"timestamptz","notNull":true}],"statusValues":["active","disabled"],"indexes":[{"name":"user_tenant_dept_id_idx","columns":["tenant_id","dept_id"]},{"name":"user_status_idx","columns":["tenant_id","status"]}]},{"schema":"core","name":"purchase_order","aggregate":"PurchaseOrder","columns":[{"name":"id","type":"uuid","notNull":true},{"name":"tenant_id","type":"uuid","notNull":true},{"name":"dept_id","type":"uuid","notNull":true,"references":"sys.dept"},{"name":"created_by","type":"uuid","notNull":true,"references":"sys.user"},{"name":"supplier_phone","type":"text","notNull":false},{"name":"amount","type":"numeric(18,2)","notNull":true},{"name":"items","type":"jsonb","notNull":true},{"name":"erp_no","type":"text","notNull":false},{"name":"status","type":"text","notNull":true},{"name":"version","type":"integer","notNull":true},{"name":"created_at","type":"timestamptz","notNull":true},{"name":"updated_at","type":"timestamptz","notNull":true}],"statusValues":["draft","pending_approval","approved","received","rejected","cancelled"],"indexes":[{"name":"purchase_order_tenant_dept_id_idx","columns":["tenant_id","dept_id"]},{"name":"purchase_order_tenant_created_by_idx","columns":["tenant_id","created_by"]},{"name":"purchase_order_status_idx","columns":["tenant_id","status"]}]},{"schema":"sys","name":"role","aggregate":"Role","columns":[{"name":"id","type":"uuid","notNull":true},{"name":"tenant_id","type":"uuid","notNull":true},{"name":"code","type":"text","notNull":true,"unique":true},{"name":"name","type":"text","notNull":true},{"name":"capabilities","type":"jsonb","notNull":true},{"name":"scopes","type":"jsonb","notNull":true},{"name":"status","type":"text","notNull":true},{"name":"version","type":"integer","notNull":true},{"name":"created_at","type":"timestamptz","notNull":true},{"name":"updated_at","type":"timestamptz","notNull":true}],"statusValues":["active","archived"],"indexes":[{"name":"role_status_idx","columns":["tenant_id","status"]}]}]}
*/
