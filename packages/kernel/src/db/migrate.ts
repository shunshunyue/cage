// 迁移执行器：框架系统表 → 项目迁移（db/migrations）→ 重建安全层。用迁移账号执行，带咨询锁防止并发。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { Registry } from '../registry.js';
import { SCHEMA_MIGRATIONS_SQL, SYSTEM_MIGRATIONS, safeLayerSql, type SchemaModel } from './ddl.js';

const MIGRATION_LOCK = 727274; // 固定的咨询锁编号

/** applied 只列出本次新提交的迁移；safeLayerRebuilt 表示最后的安全层事务也已成功提交。 */
export interface MigrateResult {
  applied: string[];
  safeLayerRebuilt: boolean;
}

/** name 是持久迁移身份而非展示名称；同名 SQL 的摘要一旦落库，后续执行必须保持一致。 */
export interface MigrationFile {
  name: string;
  sql: string;
}

/** 读取 db/migrations 下的 .sql 文件，按文件名排序 */
export function readMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}

const SNAPSHOT_RE = /\/\* cage:schema\n([\s\S]*?)\n\*\//;

/** 迁移文件末尾内嵌的结构快照（cage gen 写入），用于下一次比较 */
export function snapshotOf(m: MigrationFile): SchemaModel | null {
  const hit = SNAPSHOT_RE.exec(m.sql);
  return hit ? (JSON.parse(hit[1]) as SchemaModel) : null;
}

/** 从已排序迁移末尾向前查找最近的结构快照；它是生成基线，不是实际数据库结构扫描。 */
export function latestSnapshot(files: MigrationFile[]): SchemaModel | null {
  for (let i = files.length - 1; i >= 0; i--) {
    const s = snapshotOf(files[i]);
    if (s) return s;
  }
  return null;
}

/** 把期望结构附到迁移注释中，供下一次 gen 比较；不解析或验证手工 SQL 的实际效果。 */
export function embedSnapshot(sql: string, model: SchemaModel): string {
  return `${sql.trimEnd()}\n\n/* cage:schema\n${JSON.stringify(model)}\n*/\n`;
}

const checksum = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * 用独立迁移连接取得数据库咨询锁，先核对全部已执行迁移摘要，再逐个事务应用缺失迁移。
 * 系统、扩展和项目迁移按组合顺序执行；后一个失败不会撤销此前已经提交的迁移。
 * 最后单独重建安全层和审计分区，只有此事务也成功才返回；finally 始终尝试释放锁并关闭连接。
 * 不创建数据库或账号，不修正历史迁移，不推断真实 schema 是否存在人工漂移。
 */
export async function runMigrations(opts: {
  migrateUrl: string;
  registry: Registry;
  migrations: MigrationFile[];
  log?: (msg: string) => void;
}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString: opts.migrateUrl, application_name: 'cage-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(SCHEMA_MIGRATIONS_SQL);
    const done = new Map<string, string>((await client.query('select name, checksum from sys.schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const all = [...SYSTEM_MIGRATIONS, ...opts.registry.systemDdl.map((sql, i) => ({ name: `cage:ext_${checksum(sql)}_${i}`, sql })), ...opts.registry.systemMigrations, ...opts.migrations];
    // 在执行任何新迁移之前核对历史内容。否则同名文件被改写后会被直接跳过，
    // 本地结构快照看起来已更新，真实数据库却仍保持旧结构，下一次发布才会出错。
    for (const migration of all) {
      if (done.has(migration.name) && done.get(migration.name) !== checksum(migration.sql)) {
        throw new Error(`[CAGE-MIG-005] 已执行迁移 ${migration.name} 的内容被修改，请恢复原文件并新增迁移`);
      }
    }
    for (const m of all) {
      if (done.has(m.name)) continue;
      log(`迁移 ${m.name}`);
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into sys.schema_migrations (name, checksum) values ($1, $2)', [m.name, checksum(m.sql)]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`[CAGE-MIG-001] 迁移 ${m.name} 失败：${(e as Error).message}`);
      }
      applied.push(m.name);
    }
    // 安全层每次整体重建
    await client.query('begin');
    try {
      await client.query(safeLayerSql(opts.registry));
      await client.query('select sys.ensure_audit_partitions(3)');
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`[CAGE-MIG-002] 重建安全层失败：${(e as Error).message}`);
    }
    log('安全层已重建');
    return { applied, safeLayerRebuilt: true };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    await client.end();
  }
}
