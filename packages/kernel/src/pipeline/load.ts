// 按范围加载：把「能不能看到这条数据」直接写进 SQL 条件，范围外的数据根本查不出来。
import { sql, type Kysely, type Transaction } from 'kysely';
import { cageError } from '../errors.js';
import type { AnyAggregate } from '../primitives/aggregate.js';
import type { FindOptions, ReadRepo, Reads } from '../primitives/command.js';
import { rowToSnapshot } from '../db/rows.js';
import { compileScope } from '../scope/index.js';
import type { Ctx } from '../types.js';
import { snake } from '../util/names.js';
import { loadRelationIds } from '../relations.js';
import { isRelation } from '../primitives/fields.js';

type Db = Transaction<any> | Kysely<any>;

export const tableRef = (agg: AnyAggregate, alias = 't') => `${agg.table.schema}.${agg.table.name} as ${alias}`;

export async function loadScoped(tx: Db, agg: AnyAggregate, id: string, ctx: Ctx, forUpdate: boolean) {
  let q = tx
    .selectFrom(tableRef(agg))
    .selectAll()
    .where('t.id', '=', id)
    .where(compileScope(agg.scope, agg.name, ctx, 't'));
  if (forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? (await loadRelationIds(tx, agg, [rowToSnapshot(agg, row)], ctx))[0] : null;
}

const SYSTEM_KEYS: Record<string, string> = {
  id: 'id', status: 'status', version: 'version', createdAt: 'created_at', updatedAt: 'updated_at',
};

/** 把等值条件翻译成列条件；只允许声明过的字段 */
export function whereColumns(agg: AnyAggregate, where: Record<string, unknown> | undefined): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    const col = SYSTEM_KEYS[k] ?? (k in agg.fields ? snake(k) : undefined);
    if (!col) throw cageError('INVALID_INPUT', { field: k, message: `${agg.name} 没有字段 ${k}` });
    const f = (agg.fields as any)[k];
    if (f && (f.sql === 'jsonb' || isRelation(f))) throw cageError('INVALID_INPUT', { field: k, message: '明细或集合关系不能作为主表查询条件' });
    out.push([col, v]);
  }
  return out;
}

export function scopedFind(tx: Db, agg: AnyAggregate, ctx: Ctx, where?: Record<string, unknown>, opts: FindOptions = {}) {
  let q = tx.selectFrom(tableRef(agg)).selectAll().where(compileScope(agg.scope, agg.name, ctx, 't'));
  for (const [col, v] of whereColumns(agg, where)) {
    q = v === null ? q.where(sql.ref(`t.${col}`), 'is', null) : q.where(sql.ref(`t.${col}`), '=', v);
  }
  if (opts.orderBy) {
    const col = SYSTEM_KEYS[opts.orderBy] ?? (opts.orderBy in agg.fields ? snake(opts.orderBy) : undefined);
    const field = agg.fields[opts.orderBy];
    if (!col || (field && isRelation(field))) throw cageError('INVALID_INPUT', { field: opts.orderBy });
    q = q.orderBy(sql.ref(`t.${col}`), opts.desc ? 'desc' : 'asc');
  } else {
    q = q.orderBy('t.created_at', 'asc');
  }
  return q.limit(Math.min(opts.limit ?? 1000, 5000));
}

/** 第 7 关：只把 reads 里的聚合做成只读仓储，同样受范围约束 */
export function bindReads<R extends Reads>(tx: Db, reads: R, ctx: Ctx): Record<string, ReadRepo<any>> {
  const deps: Record<string, ReadRepo<any>> = {};
  for (const [alias, agg] of Object.entries(reads)) {
    deps[alias] = Object.freeze({
      get: async (id: string) => (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? loadScoped(tx, agg, id, ctx, false) : null),
      find: async (where?: Record<string, unknown>, opts?: FindOptions) =>
        loadRelationIds(tx, agg, (await scopedFind(tx, agg, ctx, where, opts).execute()).map((r) => rowToSnapshot(agg, r)), ctx),
      findOne: async (where: Record<string, unknown>) => {
        const rows = await scopedFind(tx, agg, ctx, where, { limit: 1 }).execute();
        return rows[0] ? (await loadRelationIds(tx, agg, [rowToSnapshot(agg, rows[0])], ctx))[0] : null;
      },
      count: async (where?: Record<string, unknown>) => {
        let q = tx.selectFrom(tableRef(agg)).select(sql<number>`count(*)::int`.as('n')).where(compileScope(agg.scope, agg.name, ctx, 't'));
        for (const [col, v] of whereColumns(agg, where)) q = q.where(sql.ref(`t.${col}`), '=', v);
        const r = await q.executeTakeFirst();
        return Number(r?.n ?? 0);
      },
    }) as ReadRepo<any>;
  }
  // 访问未声明的读依赖：类型上已经报错；运行时也给出明确的错误码
  return new Proxy(deps, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then' && prop !== 'toJSON') {
        throw new Error(`[CAGE-READS-001] handler 使用了未声明的读依赖 ${prop}（详见 docs/errors/CAGE-READS-001.md）`);
      }
      return (target as any)[prop];
    },
  });
}
