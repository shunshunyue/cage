// 数据范围：聚合声明「哪个字段是部门、哪个字段是创建人」，授权数据决定用哪个组合子。
// 每个组合子都有 SQL 翻译（compileScope）和内存判定（scopeMatches），两者语义一致。
import { sql, type RawBuilder } from 'kysely';
import type { Combinator, Ctx, ScopeGrant } from '../types.js';
import { snake } from '../util/names.js';

export interface ScopeSpec {
  /** 部门字段（dept、deptSubtree、deptSet 依赖它） */
  readonly deptField?: string;
  /** 创建人字段（self 依赖它） */
  readonly ownerField?: string;
  /** 声明时给出的建议组合子，仅用于文档与状态图 */
  readonly hint?: Combinator;
}

function spec(hint: Combinator | undefined, deptField?: string, ownerField?: string): ScopeSpec {
  return Object.freeze({ deptField, ownerField, hint });
}

/**
 * 范围声明：
 *   scope.deptSubtree('deptId')            部门字段是 deptId，创建人字段自动识别 createdBy
 *   scope.self('createdBy')                只有创建人字段
 *   scope.of({ dept: 'deptId', owner: 'ownerId' })
 *   scope.none()                           没有部门和创建人字段（只能授予 all）
 */
export const scope = {
  self: (ownerField = 'createdBy') => spec('self', undefined, ownerField),
  dept: (deptField: string, ownerField?: string) => spec('dept', deptField, ownerField),
  deptSubtree: (deptField: string, ownerField?: string) => spec('deptSubtree', deptField, ownerField),
  deptSet: (deptField: string, ownerField?: string) => spec('deptSet', deptField, ownerField),
  all: () => spec('all'),
  of: (f: { dept?: string; owner?: string }) => spec(undefined, f.dept, f.owner),
  none: () => spec(undefined),
};

/** 没有任何授权时按「仅本人」处理（默认拒绝的一部分） */
export const DEFAULT_GRANTS: ScopeGrant[] = [{ combinator: 'self' }];

export function grantsFor(ctx: Ctx, aggName: string): ScopeGrant[] {
  const g = ctx.scopes[aggName] ?? ctx.scopes['*'];
  return g && g.length > 0 ? g : DEFAULT_GRANTS;
}

/** 把一个组合子翻译成参数化 SQL 条件。字段名用 sql.ref 引用，值全部参数化，没有字符串拼接。 */
export function compileGrant(s: ScopeSpec, g: ScopeGrant, ctx: Ctx, alias?: string): RawBuilder<boolean> {
  const col = (field: string) => sql.ref(alias ? `${alias}.${snake(field)}` : snake(field));
  switch (g.combinator) {
    case 'all':
      return sql<boolean>`true`;
    case 'self': {
      const who = ctx.userId ?? ctx.onBehalfOf ?? null;
      return s.ownerField && who ? sql<boolean>`${col(s.ownerField)} = ${who}` : sql<boolean>`false`;
    }
    case 'dept':
      return s.deptField && ctx.deptId ? sql<boolean>`${col(s.deptField)} = ${ctx.deptId}` : sql<boolean>`false`;
    case 'deptSubtree':
      return s.deptField && ctx.deptPath
        ? sql<boolean>`${col(s.deptField)} in (select d.id from sys.dept d where d.tenant_id = ${ctx.tenantId} and d.ancestors like ${ctx.deptPath + '%'})`
        : sql<boolean>`false`;
    case 'deptSet':
      return s.deptField && g.deptIds && g.deptIds.length > 0
        ? sql<boolean>`${col(s.deptField)} = any(${g.deptIds}::uuid[])`
        : sql<boolean>`false`;
    default:
      throw new Error('[CAGE-SCOPE-001] 未知的范围组合子');
  }
}

/** 多个授权取并集：用 OR 连接；外层始终加租户条件。 */
export function compileScope(s: ScopeSpec, aggName: string, ctx: Ctx, alias?: string): RawBuilder<boolean> {
  const grants = grantsFor(ctx, aggName);
  const parts = grants.map((g) => compileGrant(s, g, ctx, alias));
  const tenantCol = sql.ref(alias ? `${alias}.tenant_id` : 'tenant_id');
  return sql<boolean>`(${tenantCol} = ${ctx.tenantId} and (${sql.join(parts, sql` or `)}))`;
}

/**
 * 内存判定：与 SQL 翻译语义一致。deptSubtree 需要知道记录所在部门的祖先路径，由调用方提供。
 */
export function scopeMatches(
  s: ScopeSpec,
  aggName: string,
  ctx: Ctx,
  row: Record<string, unknown> & { tenantId?: string },
  deptAncestorsOf?: (deptId: string) => string | undefined,
): boolean {
  if (row.tenantId !== undefined && row.tenantId !== ctx.tenantId) return false;
  return grantsFor(ctx, aggName).some((g) => {
    switch (g.combinator) {
      case 'all':
        return true;
      case 'self': {
        const who = ctx.userId ?? ctx.onBehalfOf ?? null;
        return !!s.ownerField && !!who && row[s.ownerField] === who;
      }
      case 'dept':
        return !!s.deptField && !!ctx.deptId && row[s.deptField] === ctx.deptId;
      case 'deptSubtree': {
        if (!s.deptField || !ctx.deptPath) return false;
        const anc = deptAncestorsOf?.(String(row[s.deptField]));
        return !!anc && anc.startsWith(ctx.deptPath);
      }
      case 'deptSet':
        return !!s.deptField && !!g.deptIds?.includes(String(row[s.deptField]));
      default:
        return false;
    }
  });
}
