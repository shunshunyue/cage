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
    (input.capability === '*' ? _ctx.actor?.kind === 'system' && _ctx.actor.id === 'system:bootstrap' : meta.catalog().includes(input.capability))
      ? ok() : violation(`[CAGE-GRANT-003] 能力点 ${input.capability} 不在能力目录里`),
});

/**
 * 保护带全部能力标记的角色。普通角色管理员不能维护它；超级管理员不能移除通配标记或停用该角色，
 * 避免初始角色失效后无法通过普通授权恢复。受信任系统身份仍可执行维护；角色名称不决定特权。
 */
export const protectSuperadminRole = (): Constraint => ({
  name: 'protectSuperadminRole',
  check: (role, ctx, input, meta) => {
    if (!role.capabilities?.some((entry: { capability: string }) => entry.capability === '*') || ctx.actor?.kind === 'system') return ok();
    if (!ctx.capabilities.has('*')) return violation('[CAGE-GRANT-001] 只有超级管理员可以维护超级管理员角色');
    if (meta.capability === 'Role.archive' || (meta.capability === 'Role.revokeCapability' && input.capability === '*'))
      return violation('[CAGE-GRANT-001] 不能停用超级管理员角色或移除全部能力标记');
    return ok();
  },
});

/**
 * 保护已分配全部能力角色的用户，防止普通用户管理员通过重置密码或更换角色接管管理员。
 * 在当前事务、当前租户及操作者可见范围中读取用户已有的角色；停用角色仍受保护。
 * 超级管理员不能停用自己，也不能移除自己最后一个有效的全部能力角色，避免误操作后无法继续授权。
 * 角色不可见或不存在时无法确认目标用户是否受保护，拒绝操作；系统身份可执行维护。
 */
export const protectSuperadminUser = (): Constraint => ({
  name: 'protectSuperadminUser',
  check: async (user, ctx, input, meta) => {
    if (ctx.actor?.kind === 'user' && ctx.userId === user.id && ctx.capabilities.has('*')) {
      if (meta.capability === 'User.disable') return violation('[CAGE-GRANT-001] 超级管理员不能停用自己的账号');
      if (meta.capability === 'User.assignRoles') {
        for (const id of input.roleIds as string[]) {
          const role = await meta.load('Role', id);
          if (role?.status === 'active' && role.capabilities?.some((entry: { capability: string }) => entry.capability === '*')) return ok();
        }
        return violation('[CAGE-GRANT-001] 超级管理员不能移除自己的全部能力角色');
      }
    }
    if (ctx.capabilities.has('*') || ctx.actor?.kind === 'system') return ok();
    for (const id of user.roleIds ?? []) {
      const role = await meta.load('Role', id);
      if (!role) return violation('[CAGE-GRANT-001] 无法确认用户角色，不能维护该账号');
      if (role?.capabilities?.some((entry: { capability: string }) => entry.capability === '*'))
        return violation('[CAGE-GRANT-001] 只有超级管理员可以维护超级管理员账号');
    }
    return ok();
  },
});

/** 防提权：不能授出自己没有的能力点；数值参数不能超过自己的。 */
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
