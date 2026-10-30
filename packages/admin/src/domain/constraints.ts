// 授权类命令的内置硬约束：代码里不存在「管理员跳过检查」的分支，超级管理员也一样要过这些约束。
import { COMBINATOR_WIDTH, type Combinator, type Constraint, type Ctx, ok, violation } from '@yss123/cage-kernel';

function ownWidth(ctx: Ctx, aggregate: string): number {
  const grants = ctx.scopes[aggregate] ?? ctx.scopes['*'] ?? [{ combinator: 'self' as Combinator }];
  return Math.max(...grants.map((g) => COMBINATOR_WIDTH[g.combinator] ?? 0));
}

/** 只能授出能力目录里存在的能力点 */
export const knownCapability = (): Constraint => ({
  name: 'knownCapability',
  check: (_role, _ctx, input, meta) =>
    meta.catalog().includes(input.capability) ? ok() : violation(`[CAGE-GRANT-003] 能力点 ${input.capability} 不在能力目录里`),
});

/** 防提权：不能授出自己没有的能力点；数值参数（额度）不能超过自己的 */
export const noEscalation = (): Constraint => ({
  name: 'noEscalation',
  check: (_role, ctx, input) => {
    const mine = ctx.capabilities.get(input.capability);
    if (!mine) return violation('[CAGE-GRANT-001] 不能授出自己没有的能力点');
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (typeof v === 'number' && typeof mine[k] === 'number' && v > (mine[k] as number)) {
        return violation(`[CAGE-GRANT-001] 参数 ${k}=${v} 超过了你自己的 ${mine[k]}`);
      }
    }
    return ok();
  },
});

/** 不能授出比自己更宽的数据范围 */
export const noWiderScope = (): Constraint => ({
  name: 'noWiderScope',
  check: (_role, ctx, input) => {
    if (!input.combinator) return ok();
    const want = COMBINATOR_WIDTH[input.combinator as Combinator] ?? 99;
    return want <= ownWidth(ctx, input.aggregate) ? ok() : violation('[CAGE-GRANT-002] 不能授出比自己更宽的数据范围');
  },
});

/** 分配角色也是授权：被分配角色里的每个能力点和范围，操作人自己都必须有 */
export const noEscalationViaRoles = (): Constraint => ({
  name: 'noEscalationViaRoles',
  check: async (user, ctx, input, meta) => {
    const before = new Set<string>(user.roleIds ?? []);
    for (const rid of input.roleIds as string[]) {
      if (before.has(rid)) continue;
      const role = await meta.load('Role', rid);
      if (!role) continue; // 交给 handler 报 ROLE_NOT_FOUND
      for (const c of role.capabilities ?? []) {
        if (!ctx.capabilities.has(c.capability)) return violation(`[CAGE-GRANT-001] 角色 ${role.code} 含有你没有的能力点 ${c.capability}`);
      }
      for (const s of role.scopes ?? []) {
        if ((COMBINATOR_WIDTH[s.combinator as Combinator] ?? 99) > ownWidth(ctx, s.aggregate)) {
          return violation(`[CAGE-GRANT-002] 角色 ${role.code} 在 ${s.aggregate} 上的范围比你更宽`);
        }
      }
    }
    return ok();
  },
});
