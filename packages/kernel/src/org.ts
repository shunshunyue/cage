// 组织目录：把「一个用户」解析成内核需要的上下文（角色、能力、范围、部门）。
// 组织模型本身是 @yss123/cage-admin 里的聚合（sys.user、sys.dept、sys.role），这里只按固定列读取。
import type { Kysely } from 'kysely';
import type { CapabilityParams, Combinator, Ctx, ScopeGrant } from './types.js';
import { COMBINATORS } from './types.js';

/** 从有效角色读取的授权数据；同一用户可有多个角色，合并不修改原始角色配置。 */
export interface RoleGrantRow {
  capabilities: { capability: string; params?: CapabilityParams }[];
  scopes: { aggregate: string; combinator: Combinator; deptIds?: string[] }[];
}

/** 多角色能力取并集，同名数值参数取最大值。 */
export function mergeCaps(roles: RoleGrantRow[]): Map<string, CapabilityParams> {
  const out = new Map<string, CapabilityParams>();
  for (const r of roles) {
    for (const c of r.capabilities ?? []) {
      const prev = out.get(c.capability);
      const next: CapabilityParams = { ...(prev ?? {}) };
      for (const [k, v] of Object.entries(c.params ?? {})) {
        const pv = next[k];
        next[k] = typeof v === 'number' && typeof pv === 'number' ? Math.max(v, pv) : pv ?? v;
      }
      out.set(c.capability, next);
    }
  }
  return out;
}

/** 多角色范围取并集：同一聚合的多个组合子用 OR 连接；deptSet 的部门合并 */
export function mergeScopes(roles: RoleGrantRow[]): Record<string, ScopeGrant[]> {
  const out: Record<string, ScopeGrant[]> = {};
  for (const r of roles) {
    for (const s of r.scopes ?? []) {
      if (!COMBINATORS.includes(s.combinator)) continue; // 授权数据异常时宁可少给
      const list = (out[s.aggregate] ??= []);
      const same = list.find((g) => g.combinator === s.combinator);
      if (same && s.combinator === 'deptSet') same.deptIds = [...new Set([...(same.deptIds ?? []), ...(s.deptIds ?? [])])];
      else if (!same) list.push(s.combinator === 'deptSet' ? { combinator: 'deptSet', deptIds: [...(s.deptIds ?? [])] } : { combinator: s.combinator });
    }
  }
  return out;
}

/** 能力点 X.unmask.kind → 明文权限 X.kind */
export function unmaskFrom(caps: Map<string, CapabilityParams>): string[] {
  const out: string[] = [];
  for (const cap of caps.keys()) {
    const m = /^([A-Z*][A-Za-z0-9]*)\.unmask\.([a-zA-Z]+)$/.exec(cap);
    if (m) out.push(`${m[1]}.${m[2]}`);
  }
  return out;
}

/** 授权快照保留用户启用状态；只有 userCtx 转换后才能作为普通用户执行上下文。 */
export interface UserGrants {
  userId: string;
  tenantId: string;
  deptId: string | null;
  deptPath: string | null;
  capabilities: Map<string, CapabilityParams>;
  scopes: Record<string, ScopeGrant[]>;
  unmask: string[];
  active: boolean;
}

/** 从系统表读取一个用户的授权（内核账号） */
/**
 * 按租户查用户并只合并 active 角色；用户不存在返回 null，用户禁用则返回 active:false。
 * 初始化角色的受控通配标记按调用方传入的当前目录展开，并取得租户内全部数据范围。
 * 本函数不做缓存，HTTP 授权缓存和审批实时加载可选择不同刷新策略，但都使用同一合并语义。
 */
export async function loadUserGrants(db: Kysely<any>, userId: string, tenantId: string, catalog: readonly string[]): Promise<UserGrants | null> {
  const user = await db
    .selectFrom('sys.user as u')
    .leftJoin('sys.dept as d', 'd.id', 'u.dept_id')
    .select(['u.id', 'u.status', 'u.dept_id', 'u.role_ids', 'd.ancestors'])
    .where('u.id', '=', userId)
    .where('u.tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!user) return null;
  const roleIds: string[] = Array.isArray(user.role_ids) ? user.role_ids : [];
  const roles: RoleGrantRow[] = roleIds.length
    ? await db
        .selectFrom('sys.role')
        .select(['capabilities', 'scopes'])
        .where('id', 'in', roleIds)
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .execute()
    : [];
  const capabilities = mergeCaps(roles);
  const superadmin = capabilities.has('*');
  if (superadmin) for (const capability of catalog) if (!capabilities.has(capability)) capabilities.set(capability, {});
  return {
    userId,
    tenantId,
    deptId: user.dept_id ?? null,
    deptPath: user.ancestors ?? null,
    capabilities,
    scopes: superadmin ? { '*': [{ combinator: 'all' }] } : mergeScopes(roles),
    unmask: unmaskFrom(capabilities),
    active: user.status === 'active',
  };
}

/** 用户上下文：禁用的用户没有任何能力 */
export function userCtx(g: UserGrants, extra: Partial<Ctx> = {}): Ctx {
  return {
    actor: { kind: 'user', id: g.userId },
    userId: g.userId,
    tenantId: g.tenantId,
    deptId: g.deptId,
    deptPath: g.deptPath,
    capabilities: g.active ? g.capabilities : new Map(),
    scopes: g.active ? g.scopes : {},
    unmask: g.active ? g.unmask : [],
    source: 'api',
    ...extra,
  };
}

/** 未登录主体默认没有能力、范围或明文权限；extra 仅供可信服务端附加请求来源信息。 */
export function anonymousCtx(tenantId: string, extra: Partial<Ctx> = {}): Ctx {
  return {
    actor: { kind: 'anonymous', id: 'anonymous' },
    userId: null,
    tenantId,
    deptId: null,
    deptPath: null,
    capabilities: new Map(),
    scopes: {},
    unmask: [],
    source: 'api',
    ...extra,
  };
}

/**
 * 系统身份上下文：能力只包含它声明过的命令；范围为全部（仍受租户约束）。
 * 审批流程、定时任务、入站回调、反应各自用它。
 */
export function systemCtx(opts: {
  kind: 'process' | 'job' | 'external' | 'reaction' | 'system';
  name: string;
  tenantId: string;
  capabilities: string[];
  onBehalfOf?: string | null;
  requestId?: string;
}): Ctx {
  const source = opts.kind === 'system' ? 'system' : opts.kind;
  return {
    actor: { kind: opts.kind, id: `${opts.kind}:${opts.name}` },
    userId: null,
    onBehalfOf: opts.onBehalfOf ?? null,
    tenantId: opts.tenantId,
    deptId: null,
    deptPath: null,
    capabilities: new Map(opts.capabilities.map((c) => [c, {}])),
    scopes: { '*': [{ combinator: 'all' }] },
    unmask: [],
    source: source as Ctx['source'],
    requestId: opts.requestId,
  };
}
