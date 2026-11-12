/**
 * 显式初始化组织及维护角色授权的服务端工具。
 * 所有组织变更调用领域命令；首次初始化用同租户咨询锁与事务避免并发创建半套组织。
 * 本模块使用受信任的系统身份，调用者应明确决定何时执行，不能把它暴露为普通业务自助授权接口。
 */
// 显式初始化组织：建根部门、超级管理员角色和初始管理员账号。
// 初始化写入受控通配标记；有效角色会随当前能力目录取得完整授权。
import { randomBytes } from 'node:crypto';
import { DEFAULT_TENANT, systemCtx, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { sql } from 'kysely';

/**
 * 初始化结果。created=false 表示租户已有用户，本次没有重置组织或密码。
 * 创建成功时才携带初始凭据与组织 ID；密码仅交付给受控调用者，不应写入日志或公开响应。
 */
export interface BootstrapResult {
  created: boolean;
  username?: string;
  password?: string;
  rootDeptId?: string;
  superadminRoleId?: string;
}

/**
 * 为初始化命令构造当前租户的系统上下文，能力取自当前注册表目录。
 * 此身份仅服务于受控初始化，不是前端可自行构造的管理员豁免。
 */
function bootstrapCtx(k: Kernel, tenantId: string): Ctx {
  return systemCtx({ kind: 'system', name: 'bootstrap', tenantId, capabilities: [...k.catalogCaps(), '*'] });
}

/**
 * 首次创建根部门、超级管理员角色及账号，并在同一事务中设置能力、范围和密码。
 * 先加租户锁再检查已有用户；已有用户直接返回 created=false，不覆盖任何密码。
 * 可通过 opts 指定租户与初始名称/凭据；未提供密码时生成随机值。
 * deliverCredentials 在数据库提交前被等待，抛错会回滚组织写入；调用方负责安全保管交付结果。
 * 数据库或命令校验失败会向外传播，成功返回凭据并不代表业务角色和生产授权策略已经配置完毕。
 */
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
    await execute('Role.grantCapability', { id: role.id, capability: '*' });
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

/** 显式授权维护工具；普通启动和生产角色不应自动调用。 */
/**
 * 显式补齐指定角色尚未拥有的目录能力，返回本次新增数量。
 * 已有授权参数保持不变；新增能力不附带业务参数。
 * 每次调用通过系统身份执行领域命令，属于高权限维护操作；多次命令并非整批单一事务。
 * 调用方必须确认目标角色与租户，不应作为生产角色自动获取新增业务能力的入口。
 */
export async function grantAll(k: Kernel, roleId: string, tenantId = DEFAULT_TENANT): Promise<number> {
  const ctx = bootstrapCtx(k, tenantId);
  const role = await k.app.selectFrom('sys.role').select('capabilities').where('id', '=', roleId).executeTakeFirst();
  const have = new Set<string>((role?.capabilities ?? []).map((c: any) => c.capability));
  let n = 0;
  for (const cap of k.catalogCaps()) {
    if (have.has(cap)) continue;
    await k.execute('Role.grantCapability', { id: roleId, capability: cap }, ctx);
    n++;
  }
  return n;
}

/**
 * 在指定租户中查找 code 为 superadmin 的角色，再复用 grantAll 补能力。
 * 角色不存在返回 0；该包装不会创建角色，也不会给其他角色授予权限。
 */
export async function grantAllToSuperadmin(k: Kernel, tenantId = DEFAULT_TENANT): Promise<number> {
  const r = await k.app.selectFrom('sys.role').select('id').where('code', '=', 'superadmin').where('tenant_id', '=', tenantId).executeTakeFirst();
  return r ? grantAll(k, r.id, tenantId) : 0;
}
