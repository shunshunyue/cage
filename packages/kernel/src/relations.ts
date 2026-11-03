// 关系存储属于所属聚合的事务边界。中间表不注册为业务聚合，不产生额外 CRUD 或能力点。
import type { Kysely, Transaction } from 'kysely';
import type { AnyAggregate } from './primitives/aggregate.js';
import type { Registry } from './registry.js';
import type { Ctx } from './types.js';
import { cageError } from './errors.js';
import { compileScope } from './scope/index.js';
import { snake } from './util/names.js';
import type { Fields } from './primitives/fields.js';

export const relationTable = (owner: AnyAggregate, field: string) => ({
  schema: owner.table.schema,
  name: `${owner.table.name}__${snake(field)}`,
});

/** 命令/已声明读依赖的内部快照包含完整关联 ID，才能保留未被本次命令修改的关系。
 * 对外读侧不使用此函数，而通过安全视图分页读取目标对象。 */
export async function loadRelationIds(
  tx: Kysely<any> | Transaction<any>, owner: AnyAggregate,
  rows: Record<string, any>[], ctx: Ctx,
): Promise<Record<string, any>[]> {
  if (!rows.length) return rows;
  for (const [key, field] of Object.entries(owner.fields as Fields)) {
    if (field.kind !== 'manyToMany') continue;
    const table = relationTable(owner, key);
    const links = await tx.selectFrom(`${table.schema}.${table.name}`)
      .select(['source_id', 'target_id']).where('tenant_id', '=', ctx.tenantId)
      .where('source_id', 'in', rows.map((row) => row.id)).orderBy('target_id').execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) row[key] = [];
    for (const link of links) byId.get(link.source_id)![key].push(link.target_id);
  }
  return rows;
}

/** 只校验新增的目标：无关字段更新不应因旧目标当前不可见而失败或丢失旧关系。
 * 新增目标必须可选择且属于同一租户；数据库的复合外键再保证持久化一致性。 */
export async function writeRelations(
  tx: Transaction<any>, reg: Registry, owner: AnyAggregate,
  previous: Record<string, any>, next: Record<string, any>, ctx: Ctx,
): Promise<void> {
  for (const [key, field] of Object.entries(owner.fields as Fields)) {
    if (field.kind !== 'manyToMany') continue;
    const before: string[] = previous[key] ?? [];
    const after: string[] = next[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const added = after.filter((id) => !before.includes(id));
    if (added.length) {
      const target = reg.aggregate(field.ref!)!;
      if (ctx.actor?.kind === 'user' && !ctx.capabilities.has(`${target.name}.read`))
        throw cageError('FORBIDDEN', { capability: `${target.name}.read` });
      const visible = await tx.selectFrom(`${target.table.schema}.${target.table.name} as target`)
        .select('target.id').where('target.id', 'in', added)
        .where('target.status', '<>', 'deleted')
        .where(compileScope(target.scope, target.name, ctx, 'target')).forKeyShare().execute();
      if (visible.length !== added.length) throw cageError('NOT_FOUND');
    }
    const table = relationTable(owner, key);
    await tx.deleteFrom(`${table.schema}.${table.name}`)
      .where('tenant_id', '=', ctx.tenantId).where('source_id', '=', next.id).execute();
    if (after.length) await tx.insertInto(`${table.schema}.${table.name}`)
      .values(after.map((id) => ({ tenant_id: ctx.tenantId, source_id: next.id, target_id: id }))).execute();
  }
}
