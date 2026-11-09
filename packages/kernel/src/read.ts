// 读侧：只用读侧账号，只查 safe 模式下的安全视图；内核在只读事务开头写会话变量，
// 行级策略和掩码由数据库兜底。忘了设置上下文时一条都查不到。
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { viewRowToObject } from './db/rows.js';
import { setSessionVars } from './db/session.js';
import { cageError } from './errors.js';
import type { Kernel } from './kernel.js';
import { type AnyAggregate, hiddenFields, sensitiveFields } from './primitives/aggregate.js';
import { isRelation, type AnyField, type Fields } from './primitives/fields.js';
import type { AnyQuery } from './primitives/flow.js';
import type { Ctx } from './types.js';
import { snake } from './util/names.js';
import { csvCell } from './transfer/csv.js';
import { relationTable } from './relations.js';

/** HTTP 查询参数与服务端查询共用；页码从 1 开始，字符串值在执行前按字段类型严格转换。 */
export interface ListParams {
  /** 从 1 开始的页码，省略默认 1；接受正安全整数或纯数字字符串，非法值明确拒绝。 */
  page?: number | string;
  /** 请求每页条数，省略默认 20；普通列表/关联读取最多 200，导出内部另设分批上限。 */
  pageSize?: number | string;
  /** 排序：字段名，前面加 - 表示倒序，例如 -createdAt */
  sort?: string;
  /** 创建时间下界（包含边界），接受合法日期或带时区 ISO 时间；省略不限制下界。 */
  createdAfter?: string;
  /** 创建时间上界（不含边界），格式同 createdAfter，必须晚于已指定的下界。 */
  createdBefore?: string;
  /** 其他键：字段等值过滤；status 可以逗号分隔多个 */
  [field: string]: unknown;
}

/** total 是当前权限/筛选条件内的总数，items 仅是当前页，不能据此推断完整关联集合。 */
export interface Page<T> {
  /** 当前页可见记录，已经安全投影；空数组只说明本页无结果。 */
  items: T[];
  /** 同权限与筛选条件的总条数，不是数据库全局行数。 */
  total: number;
  /** 实际使用的一基页码。 */
  page: number;
  /** 实际采用的分页大小，可能受服务端上限限制。 */
  pageSize: number;
}

const SYS: Record<string, string> = { id: 'id', status: 'status', version: 'version', createdAt: 'created_at', updatedAt: 'updated_at' };
const RESERVED = new Set(['page', 'pageSize', 'sort', 'createdAfter', 'createdBefore']);

function invalid(path: string, message: string): never {
  throw cageError('INVALID_INPUT', [{ path, message }]);
}

/** 拒绝负数、小数、Infinity 和非数字字符串；只有缺省值可采用默认值，错误输入不静默归一。 */
function pageNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^[0-9]+$/.test(value)))
    return invalid(path, '必须为正整数');
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : invalid(path, '必须为有限的正安全整数');
}

/** 日期过滤只接受合法日期或带时区的 ISO 时间，避免服务器本地时区猜测用户输入。 */
function dateParam(value: unknown, path: string): Date {
  if (typeof value !== 'string' || !(z.iso.date().safeParse(value).success || z.iso.datetime({ offset: true }).safeParse(value).success))
    return invalid(path, '必须为合法日期或带时区的 ISO 时间');
  return new Date(value);
}

/** 先将 URL 数值/布尔文本转换，再用字段基础 schema 校验；金额保持字符串而不转浮点数。 */
function coerce(field: AnyField | undefined, value: unknown, path: string): unknown {
  let v = value;
  if (field?.kind === 'int' || field?.kind === 'number' || path === 'version') {
    if (typeof v === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) v = Number(v);
    if (typeof v !== 'number' || !Number.isFinite(v)) return invalid(path, '必须为有限数值');
    if ((field?.kind === 'int' || path === 'version') && !Number.isSafeInteger(v)) return invalid(path, '必须为安全整数');
  } else if (field?.kind === 'bool') {
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    if (typeof v !== 'boolean') return invalid(path, '布尔值只接受 true 或 false');
  }
  if (field?.kind === 'date' && !z.iso.date().safeParse(v).success) return invalid(path, '必须为合法日期');
  if (field) {
    const parsed = field.base.safeParse(v);
    if (!parsed.success) return invalid(path, parsed.error.issues.map((issue) => issue.message).join('; '));
    return parsed.data;
  }
  if (path === 'createdAt' || path === 'updatedAt') return dateParam(v, path);
  if (path === 'id' && !z.uuid().safeParse(v).success) return invalid(path, '必须为 UUID');
  if (typeof v !== 'string' && path !== 'version') return invalid(path, '必须为字符串');
  return v;
}

/**
 * 面向用户的统一只读服务。能力检查在 TypeScript 层，行级范围与敏感掩码由 safe 视图执行。
 * 有明文交付或导出时先可靠写审计；审计失败不会返回已经查询到的数据，避免先泄露后补日志。
 */
export class ReadSide {
  constructor(private readonly k: Kernel) {}

  /** 读侧账号上的只读事务，已写入会话变量 */
  /** 所有查询共享此边界；repeatable read 用于多次读取必须看到同一快照的关联/导出场景。 */
  async tx<T>(ctx: Ctx, fn: (tx: Transaction<any>) => Promise<T>, isolation: 'read committed' | 'repeatable read' = 'read committed'): Promise<T> {
    return this.k.readDb
      .transaction()
      .setIsolationLevel(isolation)
      .setAccessMode('read only')
      .execute(async (tx) => {
        await setSessionVars(tx, ctx);
        return fn(tx);
      });
  }

  /** 解析注册聚合，未知名称统一 NOT_FOUND，不暴露内部注册细节。 */
  private agg(a: AnyAggregate | string): AnyAggregate {
    const agg = typeof a === 'string' ? this.k.registry.aggregate(a) : a;
    if (!agg) throw cageError('NOT_FOUND');
    return agg;
  }

  /** read/export 能力与数据范围分开检查；通过此函数不意味着某条记录可见。 */
  private need(ctx: Ctx, cap: string) {
    if (!ctx.actor || ctx.actor.kind === 'anonymous') throw cageError('UNAUTHENTICATED');
    if (!ctx.capabilities.has(cap)) throw cageError('FORBIDDEN', { capability: cap });
  }

  /** 明文读取敏感字段要写读审计 */
  private async auditUnmask(agg: AnyAggregate, ctx: Ctx, ids: string[], kind: 'read' | 'export', metadata: Record<string, unknown> = {}, auditDb: Kysely<any> = this.k.app) {
    const kinds = [...new Set(Object.values(sensitiveFields(agg)))].filter((x) => ctx.unmask.includes(`${agg.name}.${x}`) || ctx.unmask.includes(`*.${x}`));
    if (kind === 'read' && kinds.length === 0) return;
    try { await this.k.writeAudit(auditDb, {
      tenantId: ctx.tenantId, actor: ctx.actor?.id ?? 'anonymous', actorKind: ctx.actor?.kind ?? 'anonymous',
      onBehalfOf: ctx.onBehalfOf ?? null, source: ctx.source, kind: 'read',
      capability: `${agg.name}.${kind}`, command: null, aggregate: agg.name,
      aggregateId: ids.length === 1 ? ids[0] : null, result: 'ok',
      diff: { unmasked: kinds, rows: ids.length, ...metadata }, requestId: ctx.requestId ?? null, client: ctx.client ?? null,
    }); } catch {
      this.k.log.error({ code: 'CAGE-AUDIT-001', aggregate: agg.name, kind, requestId: ctx.requestId }, '读取审计失败，未交付数据');
      throw cageError('INTERNAL', { diagnostic: 'CAGE-AUDIT-001', phase: 'audit', operation: kind, retryable: true });
    }
  }

  /** 查询单条安全视图记录；非法 ID、范围外和不存在都按 NOT_FOUND 处理，明文审计后才交付。 */
  async get(a: AnyAggregate | string, id: string, ctx: Ctx): Promise<Record<string, any>> {
    const agg = this.agg(a);
    this.need(ctx, `${agg.name}.read`);
    if (!z.uuid().safeParse(id).success) throw cageError('NOT_FOUND');
    const row = await this.tx(ctx, (tx) => tx.selectFrom(`safe.${agg.table.name}`).selectAll().where('id', '=', id).executeTakeFirst());
    if (!row) throw cageError('NOT_FOUND');
    await this.auditUnmask(agg, ctx, [id], 'read');
    return viewRowToObject(row);
  }

  /** 普通页面最多每页 200 条；输出由安全视图已掩码，关联集合需另调 related。 */
  async list(a: AnyAggregate | string, params: ListParams, ctx: Ctx): Promise<Page<Record<string, any>>> {
    const agg = this.agg(a);
    this.need(ctx, `${agg.name}.read`);
    const res = await this.tx(ctx, (tx) => this.listIn(tx, agg, params, 200));
    await this.auditUnmask(agg, ctx, res.items.map((r) => r.id), 'read');
    return res;
  }

  /** 关联按需分页：先确认所属对象可见，再从目标安全视图读取；两侧能力、范围和掩码都生效。 */
  async related(a: AnyAggregate | string, id: string, fieldName: string, params: ListParams, ctx: Ctx): Promise<Page<Record<string, any>>> {
    const owner = this.agg(a), field = (owner.fields as Fields)[fieldName];
    this.need(ctx, `${owner.name}.read`);
    if (!field || !isRelation(field) || !z.uuid().safeParse(id).success) throw cageError('NOT_FOUND');
    const target = this.agg(field.ref!);
    this.need(ctx, `${target.name}.read`);
    const res = await this.tx(ctx, async (tx) => {
      const source = await tx.selectFrom(`safe.${owner.table.name}`).select('id').where('id', '=', id).where('status', '<>', 'deleted').executeTakeFirst();
      if (!source) throw cageError('NOT_FOUND');
      const table = relationTable(owner, fieldName);
      const restrict = field.kind === 'hasMany'
        ? (q: any) => q.where(sql.ref(snake(field.mappedBy!)), '=', id)
        : (q: any) => q.where('id', 'in', tx.selectFrom(`safe.${table.name}`).select('target_id').where('source_id', '=', id));
      return this.listIn(tx, target, params, 200, true, restrict);
    }, 'repeatable read');
    await this.auditUnmask(target, ctx, res.items.map((row) => row.id), 'read');
    return res;
  }

  /**
   * 构造安全视图分页和同口径计数，restrict 让关联读取复用相同过滤逻辑。
   * 隐藏、敏感、JSON 和集合字段不能被普通等值筛选旁路探测；默认排除 deleted。
   * 排序追加 id 作为稳定次序；时间窗口为 createdAfter 含边界、createdBefore 不含边界。
   */
  private async listIn(tx: Transaction<any>, agg: AnyAggregate, params: ListParams, maxPageSize: number, count = true, restrict: (q: any) => any = (q) => q): Promise<Page<Record<string, any>>> {
    const page = pageNumber(params.page, 'page', 1);
    const pageSize = Math.min(maxPageSize, pageNumber(params.pageSize, 'pageSize', 20));
    if (!Number.isSafeInteger((page - 1) * pageSize)) invalid('page', '分页偏移超过安全整数范围');
    const after = params.createdAfter === undefined ? undefined : dateParam(params.createdAfter, 'createdAfter');
    const before = params.createdBefore === undefined ? undefined : dateParam(params.createdBefore, 'createdBefore');
    if (after && before && after >= before) invalid('createdBefore', '必须晚于 createdAfter');
    const hidden = new Set(hiddenFields(agg));
    const view = `safe.${agg.table.name}`;
    const apply = (q: any) => {
      for (const [k, v] of Object.entries(params)) {
        if (RESERVED.has(k) || v === undefined) continue;
        const f = (agg.fields as Fields)[k];
        const col = SYS[k] ?? (f && !isRelation(f) && !hidden.has(k) && f.sql !== 'jsonb' && !f.sensitiveKind ? snake(k) : undefined);
        if (!col) throw cageError('INVALID_INPUT', [{ path: k, message: `不能按 ${k} 过滤` }]);
        if (k === 'status') {
          if (typeof v !== 'string') invalid(k, '状态必须为字符串');
          const statuses = (v as string).split(',');
          if (statuses.some((status) => !agg.states.values.includes(status))) invalid(k, '包含未声明的状态');
          q = q.where('status', 'in', statuses);
        } else q = q.where(sql.ref(col), '=', coerce(f, v, k));
      }
      if (params.status === undefined) q = q.where('status', '<>', 'deleted');
      if (after) q = q.where('created_at', '>=', after);
      if (before) q = q.where('created_at', '<', before);
      return restrict(q);
    };
    let q = apply(tx.selectFrom(view).selectAll());
    if (params.sort !== undefined && (typeof params.sort !== 'string' || !params.sort)) invalid('sort', '必须为非空字段名');
    const sortKey = typeof params.sort === 'string' ? params.sort.replace(/^-/, '') : 'createdAt';
    const sortField = (agg.fields as Fields)[sortKey];
    const sortCol = SYS[sortKey] ?? (sortField && !isRelation(sortField) && !hidden.has(sortKey) && sortField.sql !== 'jsonb' ? snake(sortKey) : undefined);
    if (!sortCol) throw cageError('INVALID_INPUT', [{ path: 'sort', message: `不能按 ${sortKey} 排序` }]);
    const desc = typeof params.sort === 'string' ? params.sort.startsWith('-') : true;
    q = q.orderBy(sql.ref(sortCol), desc ? 'desc' : 'asc').orderBy('id').limit(pageSize).offset((page - 1) * pageSize);
    const rows = await q.execute();
    const cnt = count ? await apply(tx.selectFrom(view).select(sql<number>`count(*)::int`.as('n'))).executeTakeFirst() : null;
    return { items: rows.map(viewRowToObject), total: Number(cnt?.n ?? 0), page, pageSize };
  }

  /**
   * worker 使用的导出构建器：同一只读快照内分批读取，避免翻页期间数据变化导致漏行或重复。
   * 上限用于约束单任务内存与数据库文件存储；超限明确失败，绝不能静默截断成“成功文件”。
   * HTTP 只提交任务，保留本方法供受控的服务端调用。
   */
  async export(a: AnyAggregate | string, params: ListParams, ctx: Ctx, auditTransaction?: Transaction<any>): Promise<{ filename: string; contentType: string; body: string; rows: number }> {
    const agg = this.agg(a);
    this.need(ctx, `${agg.name}.export`);
    const cols = ['id', ...Object.entries(agg.fields as Fields).filter(([, f]) => !f.isHidden && !isRelation(f)).map(([k]) => k), 'status', 'version', 'createdAt', 'updatedAt'];
    const lines = ['\uFEFF' + cols.map(csvCell).join(',')], ids: string[] = [];
    let bytes = Buffer.byteLength(lines[0]);
    await this.tx(ctx, async (tx) => {
      let total = 0;
      for (let page = 1; page === 1 || ids.length < total; page++) {
        const res = await this.listIn(tx, agg, { ...params, page, pageSize: 1000 }, 1000, page === 1);
        if (page === 1) total = res.total;
        if (total > 100_000) throw cageError('INVALID_INPUT', '导出最多支持 100000 行，请缩小筛选范围');
        for (const row of res.items) {
          const line = cols.map((c) => csvCell(row[c])).join(',');
          bytes += Buffer.byteLength(line) + 1;
          if (bytes > 20 * 1024 * 1024) throw cageError('INVALID_INPUT', '导出文件超过 20 MiB，请缩小筛选范围');
          lines.push(line); ids.push(row.id);
        }
      }
    }, 'repeatable read');
    // worker 已持有任务事务时，生成审计与文件持久化共同提交，不能再向同一 app 池领取连接。
    await this.auditUnmask(agg, ctx, ids, 'export', {}, auditTransaction);
    return { filename: `${agg.table.name}.csv`, contentType: 'text/csv; charset=utf-8', body: lines.join('\n'), rows: ids.length };
  }

  /** 执行 query 声明：需要 reads 里每个聚合的 read 能力；手写 SQL 用 :name 占位，全部参数化 */
  /**
   * SQL/build 在只读事务中执行；任意报表无法反推出全部对象 ID，因此按声明 reads 保守记录明文审计。
   * audit.purpose 另形成用途审计，任一可靠审计失败都会阻止交付，不能以空结果冒充成功。
   */
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
    // 任意报表无法可靠推导对象 ID，按 query 用途、涉及聚合及结果行数记录。
    // 即使无法静态判定 SELECT 是否投影了明文，也不得让自定义查询绕过敏感读取审计。
    for (const aggregate of query.reads) await this.auditUnmask(aggregate, ctx, [], 'read', { query: query.name, rows: rows.length, purpose: query.audit?.purpose });
    if (query.audit) {
      try { await this.k.writeAudit(this.k.app, {
        tenantId: ctx.tenantId, actor: ctx.actor!.id, actorKind: ctx.actor!.kind, source: ctx.source,
        kind: 'read', capability: `query:${query.name}`, aggregate: null, result: 'ok',
        diff: { query: query.name, purpose: query.audit.purpose, rows: rows.length, reads: query.reads.map((a) => a.name) },
        requestId: ctx.requestId ?? null, client: ctx.client ?? null,
      }); } catch {
        this.k.log.error({ code: 'CAGE-AUDIT-001', operation: `query:${query.name}`, requestId: ctx.requestId }, '查询用途审计失败，未交付数据');
        throw cageError('INTERNAL', { diagnostic: 'CAGE-AUDIT-001', phase: 'audit', operation: `query:${query.name}`, retryable: true });
      }
    }
    return rows.map(viewRowToObject);
  }
}

/** :name 占位 → 参数化 SQL（:: 类型转换不受影响） */
/** SQL 模板必须来自可信声明，用户只能提供占位参数；缺少命名参数立即报 INVALID_INPUT。 */
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

/** 外层接收字段名动态的查询参数；具体白名单、类型、分页边界在 listIn 中结合聚合校验。 */
export const listParamsSchema = z.record(z.string(), z.unknown());
