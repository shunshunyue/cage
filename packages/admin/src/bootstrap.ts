// 显式初始化组织：建根部门、超级管理员角色和初始管理员账号。
// 超级管理员只是一个拥有全部能力、范围为 all 的角色，是数据而不是代码里的特例。
import { randomBytes } from 'node:crypto';
import { DEFAULT_TENANT, systemCtx, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { sql } from 'kysely';

export interface BootstrapResult {
  created: boolean;
  username?: string;
  password?: string;
  rootDeptId?: string;
  superadminRoleId?: string;
}

function bootstrapCtx(k: Kernel, tenantId: string): Ctx {
  return systemCtx({ kind: 'system', name: 'bootstrap', tenantId, capabilities: k.catalogCaps() });
}

export async function bootstrapOrg(
  k: Kernel,
  opts: {
    tenantId?: string; adminUsername?: string; adminPassword?: string; rootDeptName?: string;
    /** 提交前交付初始凭据；交付失败须抛错，组织和账号随事务一起回滚。 */
    deliverCredentials?: (credentials: { username: string; password: string }) => void | Promise<void>;
  } = {},
): Promise<BootstrapResult> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT;
  return k.app.transaction().execute(async (tx) => {
    // 初始化失败必须整体回滚；同租户的两个初始化进程不能各自留下半套组织。
    await sql`select pg_advisory_xact_lock(hashtext('cage:organization-bootstrap'), hashtext(${tenantId}))`.execute(tx);
    const existing = await tx.selectFrom('sys.user').select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (Number(existing?.n ?? 0) > 0) return { created: false };
    const ctx = bootstrapCtx(k, tenantId);
    const execute = (command: string, input: unknown) => k.executeIn(tx, command, input, ctx, 0);
    const root = await execute('Dept.create', { name: opts.rootDeptName ?? '总部', code: 'root' });
    const role = await execute('Role.create', { code: 'superadmin', name: '超级管理员' });
    for (const cap of k.catalogCaps()) {
      await execute('Role.grantCapability', { id: role.id, capability: cap, params: cap.endsWith('.approve') ? { ceiling: 1_000_000_000 } : undefined });
    }
    await execute('Role.setScope', { id: role.id, aggregate: '*', combinator: 'all' });
    const username = opts.adminUsername ?? 'admin';
    const password = opts.adminPassword ?? randomBytes(9).toString('base64url');
    const user = await execute('User.create', { username, name: '管理员', deptId: root.id });
    await execute('User.assignRoles', { id: user.id, roleIds: [role.id] });
    await execute('User.setPassword', { id: user.id, password });
    // 先确认调用方已经保管凭据再提交，避免留下无法登录的初始管理员。
    await opts.deliverCredentials?.({ username, password });
    return { created: true, username, password, rootDeptId: root.id, superadminRoleId: role.id };
  });
}

/** 把能力目录里的全部能力授给某个角色（cage dev 在声明新增命令后调用，生产环境由管理员在 /admin 操作） */
export async function grantAll(k: Kernel, roleId: string, tenantId = DEFAULT_TENANT): Promise<number> {
  const ctx = bootstrapCtx(k, tenantId);
  const role = await k.app.selectFrom('sys.role').select('capabilities').where('id', '=', roleId).executeTakeFirst();
  const have = new Set<string>((role?.capabilities ?? []).map((c: any) => c.capability));
  let n = 0;
  for (const cap of k.catalogCaps()) {
    if (have.has(cap)) continue;
    await k.execute('Role.grantCapability', { id: roleId, capability: cap, params: cap.endsWith('.approve') ? { ceiling: 1_000_000_000 } : undefined }, ctx);
    n++;
  }
  return n;
}

export async function grantAllToSuperadmin(k: Kernel, tenantId = DEFAULT_TENANT): Promise<number> {
  const r = await k.app.selectFrom('sys.role').select('id').where('code', '=', 'superadmin').where('tenant_id', '=', tenantId).executeTakeFirst();
  return r ? grantAll(k, r.id, tenantId) : 0;
}
