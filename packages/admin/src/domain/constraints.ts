/**
 * 组织授权命令的硬约束集合，供 Role 和 User 命令声明复用。
 * 检查在内核命令流水线中执行，拒绝通过 violation 返回给调用方；约束不直接改角色或用户。
 * 各函数只实现下方明确条件：不能把能力存在性、参数比较和范围宽度检查混称为任意授权策略证明。
 */
// 授权类命令的内置硬约束：代码里不存在「管理员跳过检查」的分支，超级管理员也一样要过这些约束。
import { COMBINATOR_WIDTH, type Combinator, type Constraint, type Ctx, ok, violation } from '@yss123/cage-kernel';

/**
 * 计算操作者在目标聚合上的最大范围宽度，用于后续宽度比较。
 * 优先聚合专用授权，其次通配授权，再回退 self；返回宽度序号，不枚举实际可见记录。
 */
function ownWidth(ctx: Ctx, aggregate: string): number {
  const grants = ctx.scopes[aggregate] ?? ctx.scopes['*'] ?? [{ combinator: 'self' as Combinator }];
  return Math.max(...grants.map((g) => COMBINATOR_WIDTH[g.combinator] ?? 0));
}

/** 只能授出能力目录里存在的能力点 */
/**
 * 构造目录存在性约束。check 使用内核提供的实时目录核对 input.capability，
 * 未知能力返回 CAGE-GRANT-003；该检查不负责判断操作者是否拥有这个能力。
 */
export const knownCapability = (): Constraint => ({
  name: 'knownCapability',
  check: (_role, _ctx, input, meta) =>
    meta.catalog().includes(input.capability) ? ok() : violation(`[CAGE-GRANT-003] 能力点 ${input.capability} 不在能力目录里`),
});

/** 防提权：不能授出自己没有的能力点；数值参数（额度）不能超过自己的 */
/**
 * 构造直接授权的防提权约束：操作者必须已有目标能力。
 * 输入与操作者参数在同一键上都为 number 时，新值不能更大；其他参数类型不在这里比较。
 * 检查只返回结果，实际替换角色能力列表由 grantCapability handler 完成。
 */
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
/**
 * 构造范围宽度约束，阻止设置比操作者更宽的组合子。
 * combinator 为空表示删除已有范围，允许继续；deptSet 的具体部门集合不由本函数逐项比较。
 */
export const noWiderScope = (): Constraint => ({
  name: 'noWiderScope',
  check: (_role, ctx, input) => {
    if (!input.combinator) return ok();
    const want = COMBINATOR_WIDTH[input.combinator as Combinator] ?? 99;
    return want <= ownWidth(ctx, input.aggregate) ? ok() : violation('[CAGE-GRANT-002] 不能授出比自己更宽的数据范围');
  },
});

/** 分配角色也是授权：被分配角色里的每个能力点和范围，操作人自己都必须有 */
/**
 * 构造新增角色分配的防提权约束。对本次新增角色加载其能力与范围，逐项核对操作者。
 * 已有角色跳过重复检查；不存在的角色留给 handler 返回 ROLE_NOT_FOUND。
 * 这里核对能力标识与范围宽度，不比较每个能力的数值参数，也不实际修改用户角色。
 */
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
