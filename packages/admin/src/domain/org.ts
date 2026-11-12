/**
 * 声明部门、用户和角色及其唯一业务写入口。
 * 应用从 admin/domain 重导出后，注册表统一派生路由、契约、数据范围和审计；本文件不手写 HTTP 或 SQL。
 * 部门祖先路径服务于范围匹配，角色能力与范围服务于授权上下文，用户隐藏密码哈希只供认证流程使用。
 * handler 返回字段变化，状态、版本、事务与写审计由内核负责；角色名称本身不产生权限豁免。
 */
// 组织模型：部门、用户、角色。它们本身也是聚合，增删改都是命令，同样被鉴权、写审计。
// 业务 domain 包通过 export * from '@yss123/cage-admin/domain' 把它们纳入注册表。
import { scrypt, randomBytes } from 'node:crypto';
import {
  aggregate, command, enumOf, fail, id, json, list, ref, scope, states, text, COMBINATORS,
} from '@yss123/cage-kernel';
import { z } from 'zod';
import { noEscalation, noEscalationViaRoles, noWiderScope, knownCapability, protectSuperadminRole, protectSuperadminUser } from './constraints.js';

// ---------------- 部门 ----------------

/**
 * 部门组织单元，active 可维护，archived 为终态。
 * 范围字段使用本记录 id，祖先路径供 deptSubtree 判断；leaderId 用于部门负责人审批选人。
 * 当前命令支持创建、资料更新和停用，没有移动部门或重建整棵祖先路径的命令。
 */
export const Dept = aggregate('Dept', {
  description: '部门',
  fields: {
    name: text(100),
    code: text(64).optional(),
    parentId: ref('Dept').optional(),
    /** 祖先路径（含自己），例如 /根id/采购部id/，「本部门及下级」按前缀匹配 */
    ancestors: text(4000),
    /** 部门负责人（审批路由 approver.deptLeader 使用） */
    leaderId: id().optional(),
  },
  states: states('active', 'archived', { terminal: ['archived'] }),
  scope: scope.of({ dept: 'id' }),
  table: { schema: 'sys', name: 'dept' },
  options: { grants: 'all' },
});

/**
 * 登录与组织身份聚合，用户名唯一，部门决定基于部门的范围。
 * 角色 ID 列表由 assignRoles 维护；姓名、电话和邮箱按敏感类别掩码。
 * active/disabled 可相互切换，passwordHash 隐藏且可为空：创建用户不等于已经设置本地登录密码。
 */
export const User = aggregate('User', {
  description: '用户',
  fields: {
    username: text(64).unique(),
    name: text(100).sensitive('name'),
    deptId: ref(Dept),
    roleIds: list(id()),
    phone: text(32).sensitive('phone').optional(),
    email: text(200).sensitive('email').optional(),
    /** SSO 主体标识 */
    ssoSubject: text(200).optional(),
    /** 密码哈希：隐藏字段，不进入读侧、审计、事件和前端契约 */
    passwordHash: text(500).hidden().optional(),
  },
  states: states('active', 'disabled'),
  scope: scope.of({ dept: 'deptId' }),
  table: { schema: 'sys', name: 'user' },
  options: { grants: 'self' },
});

/**
 * 能力点及范围授权的组合，角色 code 唯一，名称只用于展示。
 * capabilities 保存能力标识及可选参数，scopes 保存聚合范围，星号代表通配聚合。
 * scope.none 只表示没有对象范围字段，不表示匿名可读或无需命令授权；archived 为终态。
 */
export const Role = aggregate('Role', {
  description: '角色',
  fields: {
    code: text(64).unique(),
    name: text(100),
    /** 能力点及可选参数；初始化写入的 * 标记代表当前目录的全部能力。 */
    capabilities: list({ capability: text(200), params: json().optional() }),
    /** 各聚合上的数据范围；aggregate 为 * 表示所有聚合 */
    scopes: list({ aggregate: text(100), combinator: enumOf(...(COMBINATORS as unknown as ['all', 'self', 'dept', 'deptSubtree', 'deptSet'])), deptIds: list(id()).optional() }),
  },
  states: states('active', 'archived', { terminal: ['archived'] }),
  scope: scope.none(),
  table: { schema: 'sys', name: 'role' },
  options: { grants: 'all' },
});
// ---------------- 部门命令 ----------------

/**
 * 创建 active 部门，使用 reads.depts 查找可访问的父部门并构造含自身的祖先路径。
 * 未指定父部门时从根路径开始；指定但查不到时返回 PARENT_NOT_FOUND。
 * 返回值只补计算字段 ancestors，其余合法输入由命令草稿承接。
 */
export const createDept = command(Dept, {
  name: 'create',
  description: '新建部门',
  from: 'new',
  to: 'active',
  input: z.object({ name: z.string().min(1).max(100), code: z.string().max(64).optional(), parentId: z.string().uuid().nullable().optional(), leaderId: z.string().uuid().nullable().optional() }),
  reads: { depts: Dept },
  handler: async (o, input, { depts }) => {
    const parent = input.parentId ? await depts.get(input.parentId) : null;
    if (input.parentId && !parent) return fail('PARENT_NOT_FOUND');
    return { ancestors: `${parent?.ancestors ?? '/'}${o.id}/` };
  },
});

/**
 * 更新 active 部门的名称、编码和负责人，保持状态与原有父子关系。
 * 省略字段保留旧值；code/leaderId 显式 null 表示清空。输入没有 parentId，不能借此移动部门。
 */
export const updateDept = command(Dept, {
  name: 'update',
  description: '修改部门名称、编码、负责人',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), name: z.string().min(1).max(100).optional(), code: z.string().max(64).nullable().optional(), leaderId: z.string().uuid().nullable().optional() }),
  handler: (o, input) => ({
    name: input.name ?? o.name,
    code: input.code === undefined ? o.code : input.code,
    leaderId: input.leaderId === undefined ? o.leaderId : input.leaderId,
  }),
});

/**
 * 停用 active 部门前，通过声明读依赖检查在职用户和活动下级部门。
 * 存在下级返回 HAS_CHILDREN，存在在职用户返回 HAS_USERS；成功后由内核迁入 archived。
 * 不会自动迁移用户、级联停用下级部门或删除历史记录。
 */
export const archiveDept = command(Dept, {
  name: 'archive',
  description: '停用部门（没有在职用户和下级部门时）',
  from: 'active',
  to: 'archived',
  reads: { users: User, depts: Dept },
  handler: async (o, _input, deps) => {
    if ((await deps.depts.count({ parentId: o.id, status: 'active' })) > 0) return fail('HAS_CHILDREN');
    if ((await deps.users.count({ deptId: o.id, status: 'active' })) > 0) return fail('HAS_USERS');
    return {};
  },
});

// ---------------- 用户 ----------------

/**
 * 用户创建与编辑共用的字段校验。phone/email 允许省略或显式 null；
 * 编辑时省略表示保留，null 表示清空；用户名和密码由各自命令单独定义。
 */
const userInput = {
  name: z.string().min(1).max(100),
  deptId: z.string().uuid(),
  phone: z.string().max(32).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
};

/**
 * 创建 active 用户，先检查用户名占用和目标部门是否可读存在。
 * 失败分别返回 USERNAME_TAKEN / DEPT_NOT_FOUND；初始 roleIds 为空，不隐式授权或设置密码。
 */
export const createUser = command(User, {
  name: 'create',
  description: '新建用户（默认没有任何角色）',
  from: 'new',
  to: 'active',
  input: z.object({ username: z.string().min(2).max(64).regex(/^[A-Za-z0-9_.@-]+$/), ...userInput, ssoSubject: z.string().max(200).nullable().optional() }),
  reads: { users: User, depts: Dept },
  handler: async (o, input, { users, depts }) => {
    if (await users.findOne({ username: input.username })) return fail('USERNAME_TAKEN');
    if (!(await depts.get(input.deptId))) return fail('DEPT_NOT_FOUND');
    return { roleIds: [] };
  },
});

/**
 * 更新 active 用户的资料；更换部门前通过 depts 读依赖验证目标。
 * 姓名与部门省略时保留原值，电话/邮箱区分省略与显式清空，角色及密码不在此命令中修改。
 */
export const updateUser = command(User, {
  name: 'update',
  description: '修改用户信息',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), name: userInput.name.optional(), deptId: userInput.deptId.optional(), phone: userInput.phone, email: userInput.email }),
  reads: { depts: Dept },
  handler: async (o, input, { depts }) => {
    if (input.deptId && !(await depts.get(input.deptId))) return fail('DEPT_NOT_FOUND');
    return {
      name: input.name ?? o.name,
      deptId: input.deptId ?? o.deptId,
      phone: input.phone === undefined ? o.phone : input.phone,
      email: input.email === undefined ? o.email : input.email,
    };
  },
});

/**
 * 替换 active 用户的完整角色列表，输入最多 50 个 ID，保存前去重。
 * 硬约束先检查新增角色不能使操作者越权，handler 再核对所有角色存在且 active。
 * 任何无效角色使整个命令失败；不会部分分配，也不自动创建缺失角色。
 */
export const assignRoles = command(User, {
  name: 'assignRoles',
  description: '设置用户的角色（不能分配包含自己没有的能力的角色）',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), roleIds: z.array(z.string().uuid()).max(50) }),
  constraints: [protectSuperadminUser(), noEscalationViaRoles()],
  reads: { roles: Role },
  handler: async (_o, input, deps) => {
    for (const rid of input.roleIds) {
      const r = await deps.roles.get(rid);
      if (!r || r.status !== 'active') return fail('ROLE_NOT_FOUND', { roleId: rid });
    }
    return { roleIds: [...new Set(input.roleIds)] };
  },
});

/**
 * 将 active 用户转为 disabled，仅声明状态变化；认证和上下文刷新据状态拒绝后续使用。
 */
export const disableUser = command(User, { name: 'disable', description: '停用用户', from: 'active', to: 'disabled', constraints: [protectSuperadminUser()], handler: () => ({}) });
/**
 * 将 disabled 用户恢复为 active，不重置原有角色、资料或密码。
 */
export const enableUser = command(User, { name: 'enable', description: '启用用户', from: 'disabled', to: 'active', constraints: [protectSuperadminUser()], handler: () => ({}) });

/** 密码哈希：scrypt$盐$哈希（纯计算，不做 IO） */
/**
 * 以随机 16 字节盐调用异步 scrypt，派生 32 字节结果并编码为认证使用的三段字符串。
 * 输入为待设置的明文密码；长度约束由调用命令执行，本函数不存储或输出明文。
 * 异步 crypto 错误会拒绝 Promise；使用异步计算避免同步哈希长时间阻塞请求事件循环。
 */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(pw, salt, 32, (error, derived) => error ? reject(error) : resolve(derived));
  });
  return `scrypt$${salt}$${key.toString('hex')}`;
}

/**
 * 为 active 用户设置新密码，输入长度 8 至 200，handler 只返回隐藏哈希字段。
 * 密码计算失败则命令失败；不返回明文、不修改用户角色，也不通过此命令恢复停用账号。
 */
export const setPassword = command(User, {
  name: 'setPassword',
  description: '重置密码',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), password: z.string().min(8).max(200) }),
  constraints: [protectSuperadminUser()],
  handler: async (_o, input) => ({ passwordHash: await hashPassword(input.password) }),
});

// ---------------- 角色命令 ----------------

/**
 * 创建 active 角色，读依赖核对 code 未占用，否则返回 CODE_TAKEN。
 * 初始能力和范围均为空，后续必须分别调用授权命令配置，角色名字不会隐式赋权。
 */
export const createRole = command(Role, {
  name: 'create',
  description: '新建角色（默认没有任何能力）',
  from: 'new',
  to: 'active',
  input: z.object({ code: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/), name: z.string().min(1).max(100) }),
  reads: { roles: Role },
  handler: async (_o, input, { roles }) => {
    if (await roles.findOne({ code: input.code })) return fail('CODE_TAKEN');
    return { capabilities: [], scopes: [] };
  },
});

/**
 * 只修改 active 角色的展示名称，保持 code、授权集合和状态不变。
 */
export const renameRole = command(Role, {
  name: 'rename',
  description: '修改角色名称',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), name: z.string().min(1).max(100) }),
  handler: (_o, input) => ({ name: input.name }),
});

/**
 * 为 active 角色新增或替换单个能力及其参数。
 * 目录存在性和直接授权防提权约束先执行；handler 移除同名旧项、加入新项并稳定排序。
 * 省略 params 保存 null，表示该能力没有额外参数，而不是继承旧参数。
 */
export const grantCapability = command(Role, {
  name: 'grantCapability',
  description: '给角色授予能力点（不能授出自己没有的能力点）',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), capability: z.string().min(1).max(200), params: z.record(z.string(), z.unknown()).optional() }),
  constraints: [protectSuperadminRole(), knownCapability(), noEscalation()],
  handler: (role, input) => ({
    capabilities: [
      ...role.capabilities.filter((c) => c.capability !== input.capability),
      { capability: input.capability, params: input.params ?? null },
    ].sort((a, b) => a.capability.localeCompare(b.capability)),
  }),
});

/**
 * 从 active 角色移除匹配标识的能力，其他能力保留。
 * 目标能力原本不存在时列表不变；用户实际上下文刷新由框架的授权机制负责。
 */
export const revokeCapability = command(Role, {
  name: 'revokeCapability',
  description: '收回角色的能力点',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), capability: z.string().min(1).max(200) }),
  constraints: [protectSuperadminRole()],
  handler: (role, input) => ({ capabilities: role.capabilities.filter((c) => c.capability !== input.capability) }),
});

/**
 * 替换 active 角色在单个聚合上的范围，先经 noWiderScope 核对操作者。
 * combinator=null 删除该聚合条目；deptSet 保存显式部门列表，其他组合子不保存部门 ID。
 * 聚合星号可表达通配范围；删除显式范围后的默认行为由内核范围规则决定，不等同于授予 all。
 */
export const setScope = command(Role, {
  name: 'setScope',
  description: '设置角色在某个聚合上的数据范围（不能授出比自己更宽的范围）',
  from: 'active',
  to: 'active',
  input: z.object({
    id: z.string().uuid(),
    aggregate: z.string().min(1).max(100),
    combinator: z.enum(['all', 'self', 'dept', 'deptSubtree', 'deptSet']).nullable(),
    deptIds: z.array(z.string().uuid()).optional(),
  }),
  constraints: [protectSuperadminRole(), noWiderScope()],
  handler: (role, input) => {
    const rest = role.scopes.filter((s) => s.aggregate !== input.aggregate);
    if (input.combinator === null) return { scopes: rest };
    return {
      scopes: [...rest, { aggregate: input.aggregate, combinator: input.combinator, deptIds: input.combinator === 'deptSet' ? input.deptIds ?? [] : null }]
        .sort((a, b) => a.aggregate.localeCompare(b.aggregate)),
    };
  },
});

/**
 * 将 active 角色停用为 archived；保留历史授权数据，角色的后续有效性由上下文加载按状态判断。
 */
export const archiveRole = command(Role, { name: 'archive', description: '停用角色', from: 'active', to: 'archived', constraints: [protectSuperadminRole()], handler: () => ({}) });
