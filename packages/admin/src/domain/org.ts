// 组织模型：部门、用户、角色。它们本身也是聚合，增删改都是命令，同样被鉴权、写审计。
// 业务 domain 包通过 export * from '@yss123/cage-admin/domain' 把它们纳入注册表。
import { scrypt, randomBytes } from 'node:crypto';
import {
  aggregate, command, enumOf, fail, id, json, list, ref, scope, states, text, COMBINATORS,
} from '@yss123/cage-kernel';
import { z } from 'zod';
import { noEscalation, noEscalationViaRoles, noWiderScope, knownCapability } from './constraints.js';

// ---------------- 部门 ----------------

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

export const Role = aggregate('Role', {
  description: '角色',
  fields: {
    code: text(64).unique(),
    name: text(100),
    /** 能力点及参数，例如 { capability: 'PurchaseOrder.approve', params: { ceiling: 50000 } } */
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

const userInput = {
  name: z.string().min(1).max(100),
  deptId: z.string().uuid(),
  phone: z.string().max(32).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
};

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

export const assignRoles = command(User, {
  name: 'assignRoles',
  description: '设置用户的角色（不能分配包含自己没有的能力的角色）',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), roleIds: z.array(z.string().uuid()).max(50) }),
  constraints: [noEscalationViaRoles()],
  reads: { roles: Role },
  handler: async (_o, input, deps) => {
    for (const rid of input.roleIds) {
      const r = await deps.roles.get(rid);
      if (!r || r.status !== 'active') return fail('ROLE_NOT_FOUND', { roleId: rid });
    }
    return { roleIds: [...new Set(input.roleIds)] };
  },
});

export const disableUser = command(User, { name: 'disable', description: '停用用户', from: 'active', to: 'disabled', handler: () => ({}) });
export const enableUser = command(User, { name: 'enable', description: '启用用户', from: 'disabled', to: 'active', handler: () => ({}) });

/** 密码哈希：scrypt$盐$哈希（纯计算，不做 IO） */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(pw, salt, 32, (error, derived) => error ? reject(error) : resolve(derived));
  });
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export const setPassword = command(User, {
  name: 'setPassword',
  description: '重置密码',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), password: z.string().min(8).max(200) }),
  handler: async (_o, input) => ({ passwordHash: await hashPassword(input.password) }),
});

// ---------------- 角色命令 ----------------

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

export const renameRole = command(Role, {
  name: 'rename',
  description: '修改角色名称',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), name: z.string().min(1).max(100) }),
  handler: (_o, input) => ({ name: input.name }),
});

export const grantCapability = command(Role, {
  name: 'grantCapability',
  description: '给角色授予能力点（不能授出自己没有的能力点）',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), capability: z.string().min(1).max(200), params: z.record(z.string(), z.unknown()).optional() }),
  constraints: [knownCapability(), noEscalation()],
  handler: (role, input) => ({
    capabilities: [
      ...role.capabilities.filter((c) => c.capability !== input.capability),
      { capability: input.capability, params: input.params ?? null },
    ].sort((a, b) => a.capability.localeCompare(b.capability)),
  }),
});

export const revokeCapability = command(Role, {
  name: 'revokeCapability',
  description: '收回角色的能力点',
  from: 'active',
  to: 'active',
  input: z.object({ id: z.string().uuid(), capability: z.string().min(1).max(200) }),
  handler: (role, input) => ({ capabilities: role.capabilities.filter((c) => c.capability !== input.capability) }),
});

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
  constraints: [noWiderScope()],
  handler: (role, input) => {
    const rest = role.scopes.filter((s) => s.aggregate !== input.aggregate);
    if (input.combinator === null) return { scopes: rest };
    return {
      scopes: [...rest, { aggregate: input.aggregate, combinator: input.combinator, deptIds: input.combinator === 'deptSet' ? input.deptIds ?? [] : null }]
        .sort((a, b) => a.aggregate.localeCompare(b.aggregate)),
    };
  },
});

export const archiveRole = command(Role, { name: 'archive', description: '停用角色', from: 'active', to: 'archived', handler: () => ({}) });
