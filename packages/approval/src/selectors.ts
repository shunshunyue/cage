/**
 * 封闭审批选人规则的数据库解析，由节点开启与候选任务查询/领取共同调用。
 * 组织规则每次按当前租户数据解析，字段规则只读取实例保存的 routable 变量；本文件不授予能力，也不写任务。
 * 领取仍需另查 active、业务批准能力和安全视图范围，选人成功不能替代最终领域命令约束。
 */
import { cageError } from '@yss123/cage-kernel';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Approver } from './route.js';

/**
 * 解析单人、角色、部门负责人或单据人员字段；支持普通连接及已持锁事务，避免再次占用写连接池。
 * 字段值允许单个 UUID 或 1–200 个 UUID，重复人员归并；null/缺失返回空，非法类型明确拒绝。
 * 空候选由开启节点时报告配置错误；列表/领取时代表当前无人符合，不扩大候选范围。
 */
export async function resolveApprovers(db: Kysely<any>, selector: Approver, vars: Record<string, unknown>, tenantId: string): Promise<string[]> {
  switch (selector.kind) {
    case 'user': return [selector.userId];
    case 'field': {
      const value = vars[selector.field];
      if (value == null) return [];
      const parsed = z.array(z.uuid()).min(1).max(200).safeParse(typeof value === 'string' ? [value] : value);
      if (!parsed.success) throw cageError('INVALID_INPUT', { reason: '审批人员字段须为 UUID 或 1–200 个 UUID 的数组' });
      return [...new Set(parsed.data)];
    }
    case 'deptLeader': {
      const deptId = vars[selector.field];
      if (typeof deptId !== 'string') return [];
      const dept = await db.selectFrom('sys.dept').select(['leader_id', 'ancestors']).where('id', '=', deptId).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!dept) return [];
      if (dept.leader_id) return [dept.leader_id];
      // 无直属负责人时从最近祖先开始查找，每次查询仍限同一租户。
      for (const id of String(dept.ancestors).split('/').filter(Boolean).reverse()) {
        const parent = await db.selectFrom('sys.dept').select('leader_id').where('id', '=', id).where('tenant_id', '=', tenantId).executeTakeFirst();
        if (parent?.leader_id) return [parent.leader_id];
      }
      return [];
    }
    case 'role': {
      const role = await db.selectFrom('sys.role').select('id').where('code', '=', selector.code).where('tenant_id', '=', tenantId).where('status', '=', 'active').executeTakeFirst();
      if (!role) return [];
      const users = await db.selectFrom('sys.user').select('id').where('tenant_id', '=', tenantId).where('status', '=', 'active')
        .where(sql<boolean>`role_ids @> ${JSON.stringify([role.id])}::jsonb`).execute();
      return users.map(user => user.id);
    }
  }
}
