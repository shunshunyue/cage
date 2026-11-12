/**
 * 采购协作名录：由业务管理员登记可参与采购复核的账号、公开业务姓名和专业领域，供草稿选人及任务操作使用。
 * 聚合通过标准命令维护，浏览器读取 safe.approval_member；名录与 sys.user 的私密资料、角色授权分离。
 * 名录在同租户内向具 ApprovalMember.read 且显式获 all 范围的采购参与者公开；加入名录不授予审批权限或范围。
 */
import { aggregate, command, ref, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

/**
 * 一位账号对应一个采购协作身份，显示姓名是管理员明确登记的业务公开值，不读取 User.name 明文。
 * active 可供新申请选择，retired 保留旧单据的人员证据；退役不取消已经承担的审批责任或撤销真实角色。
 */
export const ApprovalMember = aggregate('ApprovalMember', {
  description: '采购审批协作名录',
  fields: {
    /** 当前租户的真实用户引用；租户内唯一，禁止用多条名录为同一账号制造多个会签名额。 */
    userId: ref('User').unique(),
    /** 对采购协作者公开的展示姓名；与登录姓名独立维护，不包含电话、邮箱或其他个人资料。 */
    displayName: text(80),
    /** 供选人判断的专业领域或岗位说明，例如设备技术、合同审查；不是角色编码或权限表达式。 */
    specialty: text(120),
  },
  states: states('active', 'retired', { terminal: ['retired'] }),
  // 名录没有部门或创建人字段，因此采购参与者必须由管理员显式授予 ApprovalMember 的 all 范围。
  scope: scope.none(),
});

/**
 * 登记采购协作人，要求 ApprovalMember.create；真实账号引用和租户约束由内核处理。
 * 只保存公开业务名录，不改 User 的角色或密码，不代表所选用户可以批准任何采购单。
 */
export const createApprovalMember = command(ApprovalMember, {
  name: 'create', description: '登记采购审批协作人', from: 'new', to: 'active',
  input: z.object({ userId: z.string().uuid(), displayName: z.string().trim().min(1).max(80), specialty: z.string().trim().min(1).max(120) }),
  handler: draft => draft,
});

/**
 * 仅更新有效成员的展示姓名与专业说明，版本、范围和审计由内核维护。
 * 不接受 userId，避免已被采购单引用的协作身份悄悄换人；需要另一个账号时登记新成员。
 */
export const updateApprovalMember = command(ApprovalMember, {
  name: 'update', description: '修改采购协作人的公开资料', from: 'active', to: null,
  input: z.object({ id: z.string().uuid(), displayName: z.string().trim().min(1).max(80), specialty: z.string().trim().min(1).max(120) }),
  handler: (_draft, input) => ({ displayName: input.displayName, specialty: input.specialty }),
});

/**
 * 退役成员使后续设置/提交专业复核名单拒绝此人，保留记录供历史展示。
 * 此动作不停用登录账号、不收回角色，也不修改在途流程快照；在途处理仍按当前真实权限核验。
 */
export const retireApprovalMember = command(ApprovalMember, {
  name: 'retire', description: '停用采购审批协作名录成员', from: 'active', to: 'retired', handler: draft => draft,
});
