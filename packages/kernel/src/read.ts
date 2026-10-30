// 读侧：只用读侧账号，只查 safe 模式下的安全视图；内核在只读事务开头写会话变量，
// 行级策略和掩码由数据库兜底。忘了设置上下文时一条都查不到。
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { viewRowToObject } from './db/rows.js';
import { setSessionVars } from './db/session.js';
import { cageError } from './errors.js';
import type { Kernel } from './kernel.js';
import { type AnyAggregate, hiddenFields, sensitiveFields } from './primitives/aggregate.js';
import type { Fields } from './primitives/fields.js';
import type { AnyQuery } from './primitives/flow.js';
import type { Ctx } from './types.js';
import { snake } from './util/names.js';

export interface ListParams {
  page?: number | string;
  pageSize?: number | string;
  /** 排序：字段名，前面加 - 表示倒序，例如 -createdAt */
  sort?: string;
  createdAfter?: string;
  createdBefore?: string;
  /** 其他键：字段等值过滤；status 可以逗号分隔多个 */
  [field: string]: unknown;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const SYS: Record<string, string> = { id: 'id', status: 'status', version: 'version', createdAt: 'created_at', updatedAt: 'updated_at' };
const RESERVED = new Set(['page', 'pageSize', 'sort', 'createdAfter', 'createdBefore']);

function coerce(kind: string, v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (kind === 'int' || kind === 'number') return Number(v);
  if (kind === 'bool') return v === 'true';
  return v;
}

export class ReadSide {
  constructor(private readonly k: Kernel) {}

  /** 读侧账号上的只读事务，已写入会话变量 */
  async tx<T>(ctx: Ctx, fn: (tx: Transaction<any>) => Promise<T>): Promise<T> {
    return this.k.readDb
      .transaction()
      .setAccessMode('read only')
      .execute(async (tx) => {
        await setSessionVars(tx, ctx);
        return fn(tx);
      });
  }

  private agg(a: AnyAggregate | string): AnyAggregate {
    const agg = typeof a === 'string' ? this.k.registry.aggregate(a) : a;
    if (!agg) throw cageError('NOT_FOUND');
    return agg;
  }

  private need(ctx: Ctx, cap: string) {
    if (!ctx.actor || ctx.actor.kind === 'anonymous') throw cageError('UNAUTHENTICATED');
    if (!ctx.capabilities.has(cap)) throw cageError('FORBIDDEN', { capability: cap });
  }

  /** 明文读取敏感字段要写读审计 */
  private async auditUnmask(agg: AnyAggregate, ctx: Ctx, ids: string[], kind: 'read' | 'export') {
    const kinds = [...new Set(Object.values(sensitiveFields(agg)))].filter((x) => ctx.unmask.includes(`${agg.name}.${x}`) || ctx.unmask.includes(`*.${x}`));
    if (kind === 'read' && kinds.length === 0) return;
    await this.k.writeAudit(this.k.app, {
      tenantId: ctx.tenantId, actor: ctx.actor?.id ?? 'anonymous', actorKind: ctx.actor?.kind ?? 'anonymous',
      onBehalfOf: ctx.onBehalfOf ?? null, source: ctx.source, kind: 'read',
      capability: `${agg.name}.${kind}`, command: null, aggregate: agg.name,
      aggregateId: ids.length === 1 ? ids[0] : null, result: 'ok',
      diff: { unmasked: kinds, rows: ids.length }, requestId: ctx.requestId ?? null, client: ctx.client ?? null,
    }).catch((e) => this.k.log.warn({ err: String(e) }, '读审计写入失败'));
  }

  async get(a: AnyAggregate | string, id: string, ctx: Ctx): Promise<Record<string, any>> {
    const agg = this.agg(a);
    this.need(ctx, `${agg.name}.read`);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw cageError('NOT_FOUND');
    const row = await this.tx(ctx, (tx) => tx.selectFrom(`safe.${agg.table.name}`).selectAll().where('id', '=', id).executeTakeFirst());
    if (!row) throw cageError('NOT_FOUND');
    void this.auditUnmask(agg, ctx, [id], 'read');
    return viewRowToObject(row);
  }

  async list(a: AnyAggregate | string, params: ListParams, ctx: Ctx): Promise<Page<Record<string, any>>> {
    const agg = this.agg(a);
    this.need(ctx, `${agg.name}.read`);
    const res = await this.tx(ctx, (tx) => this.listIn(tx, agg, params, 200));
    void this.auditUnmask(agg, ctx, res.items.map((r) => r.id), 'read');
    return res;
  }

  private async listIn(tx: Transaction<any>, agg: AnyAggregate, params: ListParams, maxPageSize: number): Promise<Page<Record<string, any>>> {
    const page = Math.max(1, Number(params.page ?? 1) || 1);
    const pageSize = Math.min(maxPageSize, Math.max(1, Number(params.pageSize ?? 20) || 20));
    const hidden = new Set(hiddenFields(agg));
    const view = `safe.${agg.table.name}`;
    const apply = (q: any) => {
      for (const [k, v] of Object.entries(params)) {
        if (RESERVED.has(k) || v === undefined || v === '') continue;
        const f = (agg.fields as Fields)[k];
        const col = SYS[k] ?? (f && !hidden.has(k) && f.sql !== 'jsonb' && !f.sensitiveKind ? snake(k) : undefined);
        if (!col) throw cageError('INVALID_INPUT', [{ path: k, message: `不能按 ${k} 过滤` }]);
        if (k === 'status' && typeof v === 'string' && v.includes(',')) q = q.where('status', 'in', v.split(','));
        else q = q.where(sql.ref(col), '=', coerce(f?.kind ?? 'text', v));
      }
      if (params.status === undefined) q = q.where('status', '<>', 'deleted');
      if (params.createdAfter) q = q.where('created_at', '>=', new Date(String(params.createdAfter)));
      if (params.createdBefore) q = q.where('created_at', '<', new Date(String(params.createdBefore)));
      return q;
    };
    let q = apply(tx.selectFrom(view).selectAll());
    const sortKey = typeof params.sort === 'string' && params.sort ? params.sort.replace(/^-/, '') : 'createdAt';
    const sortCol = SYS[sortKey] ?? ((agg.fields as Fields)[sortKey] && !hidden.has(sortKey) ? snake(sortKey) : undefined);
    if (!sortCol) throw cageError('INVALID_INPUT', [{ path: 'sort', message: `不能按 ${sortKey} 排序` }]);
    const desc = typeof params.sort === 'string' ? params.sort.startsWith('-') : true;
    q = q.orderBy(sql.ref(sortCol), desc ? 'desc' : 'asc').orderBy('id').limit(pageSize).offset((page - 1) * pageSize);
    const rows = await q.execute();
    const cnt = await apply(tx.selectFrom(view).select(sql<number>`count(*)::int`.as('n'))).executeTakeFirst();
    return { items: rows.map(viewRowToObject), total: Number(cnt?.n ?? 0), page, pageSize };
  }

  /** 导出：就是读，走安全视图，自然带范围和脱敏；需要 聚合.export 能力，并写读审计 */
  async export(a: AnyAggregate | string, params: ListParams, ctx: Ctx): Promise<{ filename: string; contentType: string; body: string; rows: number }> {
    const agg = this.agg(a);
    this.need(ctx, `${agg.name}.export`);
    const res = await this.tx(ctx, (tx) => this.listIn(tx, agg, { ...params, page: 1, pageSize: 10000 }, 10000));
    const cols = ['id', ...Object.keys(agg.fields).filter((k) => !hiddenFields(agg).includes(k)), 'status', 'version', 'createdAt', 'updatedAt'];
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      // 防 CSV 公式注入
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const body = [cols.join(','), ...res.items.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    await this.auditUnmask(agg, ctx, res.items.map((r) => r.id), 'export');
    return { filename: `${agg.table.name}.csv`, contentType: 'text/csv; charset=utf-8', body: '﻿' + body, rows: res.items.length };
  }

  /** 执行 query 声明：需要 reads 里每个聚合的 read 能力；手写 SQL 用 :name 占位，全部参数化 */
  async run(q: AnyQuery | string, raw: unknown, ctx: Ctx): Promise<Record<string, any>[]> {
    const query = typeof q === 'string' ? this.k.registry.queries.find((x) => x.name === q) : q;
    if (!query) throw cageError('NOT_FOUND');
    for (const a of query.reads) this.need(ctx, `${a.name}.read`);
    const parsed = query.input.safeParse(raw ?? {});
    if (!parsed.success) throw cageError('INVALID_INPUT', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const input = parsed.data as Record<string, unknown>;
    const rows = await this.tx(ctx, async (tx) => {
      if (query.build) return (await query.build(tx as unknown as Kysely<any>, input as any).execute()) as Record<string, unknown>[];
      const compiled = compileNamedSql(query.sql!, input);
      const r = await compiled.execute(tx);
      return r.rows as Record<string, unknown>[];
    });
    return rows.map(viewRowToObject);
  }
}

/** :name 占位 → 参数化 SQL（:: 类型转换不受影响） */
export function compileNamedSql(text: string, input: Record<string, unknown>) {
  const parts: any[] = [];
  const re = /(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    parts.push(sql.raw(text.slice(last, m.index)));
    if (!(m[1] in input)) throw cageError('INVALID_INPUT', [{ path: m[1], message: `缺少查询参数 ${m[1]}` }]);
    parts.push(sql`${input[m[1]]}`);
    last = m.index + m[0].length;
  }
  parts.push(sql.raw(text.slice(last)));
  return sql<Record<string, unknown>>`${sql.join(parts, sql.raw(''))}`;
}

export const listParamsSchema = z.record(z.string(), z.unknown());
