// 数据库行与快照之间的转换：列名 snake_case ↔ 字段名 camelCase，时间统一为 ISO 字符串。
import type { AnyAggregate } from '../primitives/aggregate.js';
import { isRelation, type Fields } from '../primitives/fields.js';
import { camel, snake } from '../util/names.js';

export const SYSTEM_COLUMNS = ['id', 'tenant_id', 'status', 'version', 'created_at', 'updated_at'];

/** 只规范驱动返回的 Date；numeric 金额字符串与 JSON 内容保持原类型，避免额外精度损失。 */
function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** 行 → 快照（不含 tenantId；hidden 字段可选保留） */
/** 内部写流水线默认保留 hidden 以供业务校验；对外呈现仍必须再经过 present 或安全视图。 */
export function rowToSnapshot(agg: AnyAggregate, row: Record<string, unknown>, keepHidden = true): Record<string, any> {
  const out: Record<string, any> = {
    id: row.id,
    status: row.status,
    version: row.version,
    createdAt: normalize(row.created_at),
    updatedAt: normalize(row.updated_at),
  };
  for (const [k, f] of Object.entries(agg.fields as Fields)) {
    if (f.isHidden && !keepHidden) continue;
    const col = snake(k);
    if (col in row) out[k] = normalize(row[col]) ?? null;
  }
  return out;
}

/** 视图行（列名 snake_case）→ camelCase 对象 */
export function viewRowToObject(row: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'tenant_id') continue;
    out[camel(k)] = normalize(v);
  }
  return out;
}

/** 快照字段 → 列值（jsonb 字段序列化） */
/** 仅转换已声明且本次提供的业务字段；关系由独立事务绑定流程处理，系统列由调用者设置。 */
export function fieldsToColumns(agg: AnyAggregate, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(agg.fields as Fields)) {
    if (isRelation(f)) continue;
    if (!(k in values)) continue;
    const v = values[k];
    out[snake(k)] = f.sql === 'jsonb' && v !== null && v !== undefined ? JSON.stringify(v) : v ?? null;
  }
  return out;
}

/** 只比较业务字段，找出变化的字段 */
export function diffFields(agg: AnyAggregate, cur: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const changed: string[] = [];
  for (const k of Object.keys(agg.fields)) {
    if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(next[k] ?? null)) changed.push(k);
  }
  return changed;
}
