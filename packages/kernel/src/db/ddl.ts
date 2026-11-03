// 由声明生成数据库结构：业务表、安全视图、行级策略、in_scope 与 mask 函数。
// 业务表进入迁移历史；安全层（函数、策略、视图）每次整体重建，不写进迁移历史。
import type { AnyAggregate } from '../primitives/aggregate.js';
import { isRelation, type Fields } from '../primitives/fields.js';
import type { Registry } from '../registry.js';
import { snake } from '../util/names.js';
import { TRANSFER_MIGRATION } from '../transfer/schema.js';
import { RUNTIME_MIGRATION } from './runtime-schema.js';
import { FILE_MIGRATION } from '../files/schema.js';
import { relationTable } from '../relations.js';

export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
export const qt = (t: { schema: string; name: string }) => `${q(t.schema)}.${q(t.name)}`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---------------- 结构模型（迁移比较用） ----------------

export interface ColumnModel {
  name: string;
  type: string;
  notNull: boolean;
  /** 外键目标表，例如 sys.dept */
  references?: string;
  unique?: boolean;
  /** 枚举取值（CHECK 约束） */
  values?: string[];
}

export interface TableModel {
  schema: string;
  name: string;
  aggregate: string;
  columns: ColumnModel[];
  statusValues: string[];
  /** 索引也表达租户复合唯一键，供自动关系表的复合外键引用。 */
  indexes: { name: string; columns: string[]; unique?: boolean }[];
  /** 物理关联表不是聚合：没有状态、版本、独立命令和能力点。 */
  relation?: { field: string; source: string; target: string };
}

export interface SchemaModel {
  version: 1;
  tables: TableModel[];
}

export function tableModel(agg: AnyAggregate, reg: Registry): TableModel {
  const t = agg.table;
  const columns: ColumnModel[] = [
    { name: 'id', type: 'uuid', notNull: true },
    { name: 'tenant_id', type: 'uuid', notNull: true },
  ];
  for (const [k, f] of Object.entries(agg.fields as Fields)) {
    if (isRelation(f)) continue;
    const target = f.ref ? reg.aggregate(f.ref) : undefined;
    columns.push({
      name: snake(k),
      type: f.sql,
      notNull: !f.isOptional,
      references: target ? `${target.table.schema}.${target.table.name}` : undefined,
      unique: f.isUnique || undefined,
      values: f.kind === 'enum' ? [...(f.values ?? [])] : undefined,
    });
  }
  columns.push(
    { name: 'status', type: 'text', notNull: true },
    { name: 'version', type: 'integer', notNull: true },
    { name: 'created_at', type: 'timestamptz', notNull: true },
    { name: 'updated_at', type: 'timestamptz', notNull: true },
  );
  const indexes: TableModel['indexes'] = [];
  const scopeCols = [agg.scope.deptField, agg.scope.ownerField].filter((x): x is string => !!x && x !== 'id');
  for (const f of scopeCols) indexes.push({ name: `${t.name}_tenant_${snake(f)}_idx`, columns: ['tenant_id', snake(f)] });
  indexes.push({ name: `${t.name}_status_idx`, columns: ['tenant_id', 'status'] });
  for (const [k, f] of Object.entries(agg.fields as Fields)) {
    if (f.kind === 'ref' && !scopeCols.includes(k)) indexes.push({ name: `${t.name}_${snake(k)}_idx`, columns: [snake(k)] });
  }
  const participates = reg.aggregates.some((owner) => Object.values(owner.fields as Fields)
    .some((f) => f.kind === 'manyToMany' && (owner === agg || f.ref === agg.name)));
  if (participates) indexes.push({ name: `${t.name}_tenant_id_uq`, columns: ['tenant_id', 'id'], unique: true });
  return { schema: t.schema, name: t.name, aggregate: agg.name, columns, statusValues: [...agg.states.values], indexes };
}

/** 按外键依赖排序：被引用的表在前 */
export function schemaModel(reg: Registry): SchemaModel {
  const models = reg.aggregates.map((a) => tableModel(a, reg));
  const key = (t: TableModel) => `${t.schema}.${t.name}`;
  const byKey = new Map(models.map((m) => [key(m), m]));
  const out: TableModel[] = [];
  const seen = new Set<string>();
  const visit = (m: TableModel, stack: Set<string>) => {
    if (seen.has(key(m))) return;
    stack.add(key(m));
    for (const c of m.columns) {
      const dep = c.references && byKey.get(c.references);
      if (dep && !stack.has(key(dep))) visit(dep, stack);
    }
    stack.delete(key(m));
    seen.add(key(m));
    out.push(m);
  };
  for (const m of [...models].sort((a, b) => key(a).localeCompare(key(b)))) visit(m, new Set());
  // 主表及复合唯一键先就绪，再建立关联表，避免前向外键依赖。
  for (const owner of reg.aggregates) for (const [field, f] of Object.entries(owner.fields as Fields)) {
    if (f.kind !== 'manyToMany') continue;
    const target = reg.aggregate(f.ref!)!;
    const table = relationTable(owner, field);
    out.push({ ...table, aggregate: owner.name, relation: {
      field, source: `${owner.table.schema}.${owner.table.name}`, target: `${target.table.schema}.${target.table.name}`,
    }, columns: ['tenant_id', 'source_id', 'target_id'].map((name) => ({ name, type: 'uuid', notNull: true })),
    statusValues: [], indexes: [{ name: `${table.name.slice(0, 52)}_target_idx`, columns: ['tenant_id', 'target_id'] }] });
  }
  return { version: 1, tables: out };
}

function columnSql(t: TableModel, c: ColumnModel, forCreate: boolean): string {
  let s = `${q(c.name)} ${c.type}`;
  if (c.name === 'id') return `${s} PRIMARY KEY DEFAULT gen_random_uuid()`;
  if (c.notNull && forCreate) s += ' NOT NULL';
  if (c.name === 'version') s += ' DEFAULT 1';
  if (c.name === 'created_at' || c.name === 'updated_at') s += ' DEFAULT now()';
  if (c.references) {
    const [rs, rn] = c.references.split('.');
    s += ` REFERENCES ${q(rs)}.${q(rn)}(id)`;
  }
  if (c.values) s += ` CONSTRAINT ${q(`${t.name}_${c.name}_check`)} CHECK (${q(c.name)} IN (${c.values.map(lit).join(', ')}))`;
  return s;
}

function statusCheckSql(t: TableModel): string {
  return `CONSTRAINT ${q(`${t.name}_status_check`)} CHECK (status IN (${t.statusValues.map(lit).join(', ')}))`;
}

export function createTableSql(t: TableModel): string {
  const cols = t.columns.map((c) => `  ${columnSql(t, c, true)}`);
  if (t.relation) {
    cols.push('  PRIMARY KEY (tenant_id, source_id, target_id)', ...relationForeignKeys(t).map((fk) => `  ${fk}`));
  } else cols.push(`  ${statusCheckSql(t)}`);
  const lines = [`CREATE TABLE IF NOT EXISTS ${qt(t)} (`, cols.join(',\n'), ');'];
  for (const c of t.columns.filter((x) => x.unique)) {
    lines.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${t.name}_${c.name}_uq`)} ON ${qt(t)} (tenant_id, ${q(c.name)});`);
  }
  for (const i of t.indexes) {
    lines.push(indexSql(t, i));
  }
  if (t.relation) lines.push(`GRANT DELETE ON ${qt(t)} TO cage_app;`);
  return lines.join('\n');
}

const tableNameSql = (name: string) => name.split('.').map(q).join('.');
const indexSql = (t: TableModel, i: TableModel['indexes'][number]) =>
  `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(i.name)} ON ${qt(t)} (${i.columns.map(q).join(', ')});`;

/** 两个复合外键把租户一致性放进数据库；解绑只删链接，源对象硬删除才级联清理链接。 */
function relationForeignKeys(t: TableModel): string[] {
  return [
    `CONSTRAINT ${q(`${t.name.slice(0, 53)}_source_fk`)} FOREIGN KEY (tenant_id, source_id) REFERENCES ${tableNameSql(t.relation!.source)} (tenant_id, id) ON DELETE CASCADE`,
    `CONSTRAINT ${q(`${t.name.slice(0, 53)}_target_fk`)} FOREIGN KEY (tenant_id, target_id) REFERENCES ${tableNameSql(t.relation!.target)} (tenant_id, id)`,
  ];
}

/**
 * 比较两份结构，生成迁移草稿语句。破坏性变更（删表、删列）只生成注释，按「先扩展再收缩」由人决定。
 */
export function diffSchemas(prev: SchemaModel | null, next: SchemaModel): string[] {
  const out: string[] = [];
  const prevMap = new Map((prev?.tables ?? []).map((t) => [`${t.schema}.${t.name}`, t]));
  const nextMap = new Map(next.tables.map((t) => [`${t.schema}.${t.name}`, t]));
  for (const t of next.tables) {
    const p = prevMap.get(`${t.schema}.${t.name}`);
    if (!p) {
      out.push(`-- 新表：来自聚合 ${t.aggregate}\n${createTableSql(t)}`);
      continue;
    }
    const pc = new Map(p.columns.map((c) => [c.name, c]));
    const nc = new Map(t.columns.map((c) => [c.name, c]));
    for (const c of t.columns) {
      const old = pc.get(c.name);
      if (!old) {
        if (c.notNull) {
          out.push(
            `-- 新列 ${t.aggregate}.${c.name}（必填）：先加可空列，回填后再加 NOT NULL\n` +
              `ALTER TABLE ${qt(t)} ADD COLUMN IF NOT EXISTS ${columnSql(t, c, false)};\n` +
              `-- TODO 回填：UPDATE ${qt(t)} SET ${q(c.name)} = … WHERE ${q(c.name)} IS NULL;\n` +
              `ALTER TABLE ${qt(t)} ALTER COLUMN ${q(c.name)} SET NOT NULL;`,
          );
        } else {
          out.push(`ALTER TABLE ${qt(t)} ADD COLUMN IF NOT EXISTS ${columnSql(t, c, false)};`);
        }
        if (c.unique) out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${t.name}_${c.name}_uq`)} ON ${qt(t)} (tenant_id, ${q(c.name)});`);
        continue;
      }
      if (old.type !== c.type) {
        out.push(`-- 列类型变化 ${t.aggregate}.${c.name}：${old.type} → ${c.type}，请确认 USING 表达式\nALTER TABLE ${qt(t)} ALTER COLUMN ${q(c.name)} TYPE ${c.type} USING ${q(c.name)}::${c.type};`);
      }
      if (old.notNull !== c.notNull) {
        out.push(`ALTER TABLE ${qt(t)} ALTER COLUMN ${q(c.name)} ${c.notNull ? 'SET' : 'DROP'} NOT NULL;`);
      }
      if (JSON.stringify(old.values ?? null) !== JSON.stringify(c.values ?? null)) {
        out.push(`ALTER TABLE ${qt(t)} DROP CONSTRAINT IF EXISTS ${q(`${t.name}_${c.name}_check`)};`);
        if (c.values) out.push(`ALTER TABLE ${qt(t)} ADD CONSTRAINT ${q(`${t.name}_${c.name}_check`)} CHECK (${q(c.name)} IN (${c.values.map(lit).join(', ')}));`);
      }
      if (!old.unique && c.unique) out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${t.name}_${c.name}_uq`)} ON ${qt(t)} (tenant_id, ${q(c.name)});`);
      if (old.unique && !c.unique) out.push(`DROP INDEX IF EXISTS ${q(t.schema)}.${q(`${t.name}_${c.name}_uq`)};`);
      if (old.references !== c.references && c.references) {
        const [rs, rn] = c.references.split('.');
        out.push(`ALTER TABLE ${qt(t)} ADD FOREIGN KEY (${q(c.name)}) REFERENCES ${q(rs)}.${q(rn)}(id);`);
      }
    }
    for (const c of p.columns) {
      if (!nc.has(c.name)) {
        out.push(`-- 收缩：字段 ${t.aggregate}.${c.name} 已从声明删除。确认所有读写都已切走后再取消注释（先扩展再收缩）\n-- ALTER TABLE ${qt(t)} DROP COLUMN ${q(c.name)};`);
      }
    }
    if (!t.relation && JSON.stringify(p.statusValues) !== JSON.stringify(t.statusValues)) {
      const removed = p.statusValues.filter((s) => !t.statusValues.includes(s));
      if (removed.length) out.push(`-- 注意：状态 ${removed.join(', ')} 被删除，先确认没有数据处于这些状态`);
      out.push(`ALTER TABLE ${qt(t)} DROP CONSTRAINT IF EXISTS ${q(`${t.name}_status_check`)};\nALTER TABLE ${qt(t)} ADD ${statusCheckSql(t)};`);
    }
    const pi = new Set(p.indexes.map((i) => i.name));
    for (const i of t.indexes) if (!pi.has(i.name)) out.push(indexSql(t, i));
    if (t.relation && p.relation && JSON.stringify(t.relation) !== JSON.stringify(p.relation)) {
      out.push(`-- 关联目标变化：请先迁移已有链接，再应用新的外键`);
      for (const side of ['source', 'target']) out.push(`ALTER TABLE ${qt(t)} DROP CONSTRAINT ${q(`${t.name.slice(0, 53)}_${side}_fk`)};`);
      for (const fk of relationForeignKeys(t)) out.push(`ALTER TABLE ${qt(t)} ADD ${fk};`);
    }
  }
  for (const [k, p] of prevMap) {
    if (!nextMap.has(k)) out.push(`-- 收缩：聚合 ${p.aggregate} 已从声明删除。确认后再取消注释\n-- DROP TABLE ${qt(p)};`);
  }
  return out;
}

// ---------------- 安全层：函数、策略、视图（每次整体重建） ----------------

export const IN_SCOPE_SQL = `
-- 生成物：范围判断。读取会话变量 app.scopes（{"聚合":[{"c":"组合子","deptIds":[...]}]}），多个授权取并集。
-- SECURITY DEFINER：以表属主身份读部门表，避免部门表自己的行级策略递归。
CREATE OR REPLACE FUNCTION sys.in_scope(agg text, dept uuid, owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, sys AS $$
  SELECT coalesce(bool_or(
    CASE g->>'c'
      WHEN 'all' THEN true
      WHEN 'self' THEN owner IS NOT NULL AND owner = nullif(current_setting('app.user_id', true), '')::uuid
      WHEN 'dept' THEN dept IS NOT NULL AND dept = nullif(current_setting('app.dept_id', true), '')::uuid
      WHEN 'deptSubtree' THEN dept IN (
        SELECT d.id FROM sys.dept d
        WHERE d.ancestors LIKE nullif(current_setting('app.dept_path', true), '') || '%')
      WHEN 'deptSet' THEN dept = ANY (ARRAY(SELECT jsonb_array_elements_text(coalesce(g->'deptIds', '[]'::jsonb)))::uuid[])
      ELSE false
    END), false)
  FROM jsonb_array_elements(coalesce(
    nullif(current_setting('app.scopes', true), '')::jsonb -> agg,
    nullif(current_setting('app.scopes', true), '')::jsonb -> '*',
    '[{"c":"self"}]'::jsonb)) AS g
$$;`;

export const MASK_SQL = `
-- 生成物：按敏感种类掩码。持有「聚合.种类」明文权限时原样返回。
CREATE OR REPLACE FUNCTION sys.mask(agg text, kind text, val text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN val IS NULL THEN NULL
    WHEN (agg || '.' || kind) = ANY (string_to_array(coalesce(current_setting('app.unmask', true), ''), ','))
      OR ('*.' || kind) = ANY (string_to_array(coalesce(current_setting('app.unmask', true), ''), ',')) THEN val
    WHEN kind = 'phone' THEN CASE WHEN length(val) >= 7 THEN left(val, 3) || '****' || right(val, 4) ELSE '****' END
    WHEN kind = 'idCard' THEN CASE WHEN length(val) >= 8 THEN left(val, 4) || '**********' || right(val, 4) ELSE '****' END
    WHEN kind = 'bankCard' THEN '**** **** **** ' || right(val, 4)
    WHEN kind = 'email' THEN CASE WHEN strpos(val, '@') > 1 THEN left(val, 1) || '***' || substr(val, strpos(val, '@')) ELSE '******' END
    WHEN kind = 'name' THEN left(val, 1) || '**'
    WHEN kind = 'address' THEN left(val, 6) || '******'
    ELSE '******'
  END
$$;`;

export function aggregateSafeSql(agg: AnyAggregate): string {
  const t = agg.table;
  const dept = agg.scope.deptField ? q(snake(agg.scope.deptField)) : 'NULL::uuid';
  const owner = agg.scope.ownerField ? q(snake(agg.scope.ownerField)) : 'NULL::uuid';
  const cols: string[] = ['id'];
  for (const [k, f] of Object.entries(agg.fields as Fields)) {
    if (f.isHidden || isRelation(f)) continue;
    const c = q(snake(k));
    cols.push(f.sensitiveKind ? `sys.mask(${lit(agg.name)}, ${lit(f.sensitiveKind)}, ${c}::text) AS ${c}` : c);
  }
  cols.push('status', 'version', 'created_at', 'updated_at');
  const view = `${q('safe')}.${q(t.name)}`;
  return [
    `-- ${agg.name}：行级策略 + 安全视图`,
    `ALTER TABLE ${qt(t)} ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS scope_read ON ${qt(t)};`,
    `CREATE POLICY scope_read ON ${qt(t)} FOR SELECT TO cage_view_owner USING (`,
    `  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    `  AND sys.in_scope(${lit(agg.name)}, ${dept}, ${owner}));`,
    `DROP POLICY IF EXISTS kernel_rw ON ${qt(t)};`,
    `CREATE POLICY kernel_rw ON ${qt(t)} TO cage_app USING (true) WITH CHECK (true);`,
    `DROP VIEW IF EXISTS ${view};`,
    `CREATE VIEW ${view} WITH (security_barrier) AS`,
    `  SELECT ${cols.join(', ')}`,
    `  FROM ${qt(t)};`,
    `ALTER VIEW ${view} OWNER TO cage_view_owner;`,
    `GRANT SELECT ON ${view} TO cage_read;`,
  ].join('\n');
}

export const SYSTEM_SAFE_SQL = `
-- 审计查询视图：读侧账号经系统管理接口使用，按租户过滤
DROP VIEW IF EXISTS safe.audit_log;
CREATE VIEW safe.audit_log WITH (security_barrier) AS
  SELECT id, at, actor, actor_kind, on_behalf_of, source, kind, capability, command, aggregate, aggregate_id,
         result, diff, request_id, idempotency_key, client
  FROM sys.audit_log
  WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
ALTER VIEW safe.audit_log OWNER TO cage_view_owner;
GRANT SELECT ON safe.audit_log TO cage_read;`;

/** 整个安全层：先删掉旧的 safe 视图，再按声明重建（幂等） */
export function safeLayerSql(reg: Registry): string {
  // 关系视图依赖两侧主视图，先删除框架标记的旧关系视图（包括已删除声明的关系）。
  // 不用 CASCADE，防止顺带移除用户自己维护的数据库对象。
  const parts = [IN_SCOPE_SQL, MASK_SQL, `DO $$ DECLARE v record; BEGIN
    FOR v IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'safe' AND c.relkind = 'v' AND obj_description(c.oid, 'pg_class') = 'cage:relation'
    LOOP EXECUTE format('DROP VIEW safe.%I', v.relname); END LOOP;
  END $$;`];
  for (const a of reg.aggregates) parts.push(aggregateSafeSql(a));
  for (const t of schemaModel(reg).tables) if (t.relation) {
    const source = t.relation.source.split('.')[1], target = t.relation.target.split('.')[1];
    const view = `${q('safe')}.${q(t.name)}`;
    parts.push([
      `ALTER TABLE ${qt(t)} ENABLE ROW LEVEL SECURITY;`,
      `DROP POLICY IF EXISTS scope_read ON ${qt(t)};`,
      `CREATE POLICY scope_read ON ${qt(t)} FOR SELECT TO cage_view_owner USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);`,
      `DROP POLICY IF EXISTS kernel_rw ON ${qt(t)};`,
      `CREATE POLICY kernel_rw ON ${qt(t)} TO cage_app USING (true) WITH CHECK (true);`,
      `CREATE VIEW ${view} WITH (security_barrier) AS SELECT link.source_id, link.target_id FROM ${qt(t)} link`,
      `JOIN safe.${q(source)} src ON src.id = link.source_id JOIN safe.${q(target)} dst ON dst.id = link.target_id`,
      `WHERE src.status <> 'deleted' AND dst.status <> 'deleted';`,
      `COMMENT ON VIEW ${view} IS 'cage:relation';`,
      `ALTER VIEW ${view} OWNER TO cage_view_owner;`,
      `GRANT SELECT ON ${view} TO cage_read;`,
    ].join('\n'));
  }
  parts.push(SYSTEM_SAFE_SQL);
  return parts.join('\n\n');
}

// ---------------- 初始化脚本与框架系统表 ----------------

export interface BootstrapPasswords {
  app: string;
  read: string;
  migrate: string;
}

/** 建库时执行一次（超级用户）：模式、账号、默认权限 */
export function bootstrapSql(pw: BootstrapPasswords, dbName?: string): string {
  const role = (name: string, login: boolean, password?: string) => `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(name)}) THEN
    CREATE ROLE ${name} ${login ? 'LOGIN' : 'NOLOGIN'}${password ? ` PASSWORD ${lit(password)}` : ''};
  ${password ? `ELSE ALTER ROLE ${name} ${login ? 'LOGIN' : 'NOLOGIN'} PASSWORD ${lit(password)};` : ''}
  END IF;
END $$;`;
  return `
-- db/bootstrap.sql：框架提供，建库时执行一次
CREATE EXTENSION IF NOT EXISTS pgcrypto;
${role('cage_app', true, pw.app)}
${role('cage_read', true, pw.read)}
${role('cage_view_owner', false)}
${role('cage_migrate', true, pw.migrate)}
${dbName ? `GRANT CONNECT, CREATE ON DATABASE ${q(dbName)} TO cage_migrate;\nGRANT CONNECT ON DATABASE ${q(dbName)} TO cage_app, cage_read;` : ''}
CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION cage_migrate;
CREATE SCHEMA IF NOT EXISTS sys AUTHORIZATION cage_migrate;
CREATE SCHEMA IF NOT EXISTS safe AUTHORIZATION cage_migrate;
CREATE SCHEMA IF NOT EXISTS flow AUTHORIZATION cage_migrate;
-- 迁移账号要把视图属主改成 cage_view_owner，必须是它的成员
GRANT cage_view_owner TO cage_migrate;
GRANT USAGE ON SCHEMA core, sys, flow TO cage_app;
GRANT USAGE ON SCHEMA core, sys TO cage_view_owner;
GRANT CREATE, USAGE ON SCHEMA safe TO cage_view_owner;
GRANT USAGE ON SCHEMA safe TO cage_read;
REVOKE ALL ON SCHEMA core, sys, flow FROM cage_read;
REVOKE ALL ON SCHEMA core, sys, safe, flow FROM PUBLIC;
-- 以后迁移建的表：内核账号读写但不能删除；视图属主只能读
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA core GRANT SELECT, INSERT, UPDATE ON TABLES TO cage_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA core GRANT SELECT ON TABLES TO cage_view_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA sys GRANT SELECT, INSERT, UPDATE ON TABLES TO cage_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA sys GRANT SELECT ON TABLES TO cage_view_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA sys GRANT USAGE, SELECT ON SEQUENCES TO cage_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA flow GRANT SELECT, INSERT, UPDATE ON TABLES TO cage_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA flow GRANT USAGE, SELECT ON SEQUENCES TO cage_app;
`;
}

/** 单租户部署使用的默认租户（启用多租户时每个租户一行 sys.tenant） */
export const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

/** 框架系统表（框架自己的迁移流，按名字记入 sys.schema_migrations） */
export const SYSTEM_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: 'cage:0001_system',
    sql: `
CREATE TABLE IF NOT EXISTS sys.tenant (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sys.tenant (id, name) VALUES ('${DEFAULT_TENANT}', 'default') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS sys.session (
  id text PRIMARY KEY,
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  step_up_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS session_user_idx ON sys.session (user_id);
GRANT DELETE ON sys.session TO cage_app;

CREATE TABLE IF NOT EXISTS sys.idempotency (
  key text PRIMARY KEY,
  status text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
GRANT DELETE ON sys.idempotency TO cage_app;

CREATE TABLE IF NOT EXISTS sys.outbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event text NOT NULL,
  aggregate text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  actor jsonb,
  trace jsonb,
  request_id text,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  next_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_status_next_idx ON sys.outbox (status, next_at);
CREATE INDEX IF NOT EXISTS outbox_aggregate_idx ON sys.outbox (aggregate_id, id);

CREATE TABLE IF NOT EXISTS sys.processed_event (
  event_id bigint NOT NULL,
  consumer text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

CREATE TABLE IF NOT EXISTS sys.audit_log (
  id bigserial,
  at timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid NOT NULL,
  actor text NOT NULL,
  actor_kind text NOT NULL,
  on_behalf_of uuid,
  source text NOT NULL,
  kind text NOT NULL DEFAULT 'write',
  capability text,
  command text,
  aggregate text,
  aggregate_id uuid,
  result text NOT NULL,
  diff jsonb,
  request_id text,
  idempotency_key text,
  client jsonb,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE TABLE IF NOT EXISTS sys.audit_log_default PARTITION OF sys.audit_log DEFAULT;
REVOKE ALL ON sys.audit_log FROM cage_app;
GRANT INSERT ON sys.audit_log TO cage_app;
REVOKE UPDATE, DELETE ON sys.audit_log FROM cage_app;
GRANT USAGE ON SEQUENCE sys.audit_log_id_seq TO cage_app;

-- 按月建分区：迁移时与 worker 每天调用
CREATE OR REPLACE FUNCTION sys.ensure_audit_partitions(months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sys AS $$
DECLARE
  m date := date_trunc('month', now())::date;
  i int;
  name text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    name := 'audit_log_' || to_char(m + (i || ' month')::interval, 'YYYYMM');
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'sys' AND c.relname = name) THEN
      BEGIN
        EXECUTE format('CREATE TABLE sys.%I PARTITION OF sys.audit_log FOR VALUES FROM (%L) TO (%L)',
          name, m + (i || ' month')::interval, m + ((i + 1) || ' month')::interval);
      EXCEPTION WHEN others THEN
        RAISE NOTICE '跳过分区 %: %', name, SQLERRM;
      END;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION sys.ensure_audit_partitions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sys.ensure_audit_partitions(int) TO cage_app;

CREATE TABLE IF NOT EXISTS sys.sync_record (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  connector text NOT NULL,
  operation text NOT NULL,
  ref_id text,
  idempotency_key text,
  status text NOT NULL,
  http_status int,
  attempts int NOT NULL DEFAULT 1,
  request jsonb,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_record_key_uq ON sys.sync_record (connector, operation, idempotency_key);

CREATE TABLE IF NOT EXISTS sys.dead_letter (
  id bigserial PRIMARY KEY,
  outbox_id bigint NOT NULL,
  tenant_id uuid NOT NULL,
  event text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  error text,
  attempts int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by text,
  handled_at timestamptz,
  resolution text
);

CREATE TABLE IF NOT EXISTS sys.job_state (
  name text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  TRANSFER_MIGRATION,
  RUNTIME_MIGRATION,
  FILE_MIGRATION,
];

export const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS sys.schema_migrations (
  name text PRIMARY KEY,
  checksum text,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;
