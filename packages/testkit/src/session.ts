/**
 * 为安全视图集成测试构建会话级 PostgreSQL 上下文变量设置语句。
 * 与内核事务级变量不同，这里刻意保持在测试专属读连接中，使裸 SQL 权限检查具有与身份一致的范围。
 * 只返回 SQL 文本，不获取连接；应与独占测试连接配合，不能把不同用户共享在同一未隔离会话中。
 */
// 会话级（不是事务级）的会话变量：用于模拟「拿着读侧连接直接写裸 SQL」。
import type { Ctx } from '@yss123/cage-kernel';
import { scopesJson } from '@yss123/cage-kernel/db';

/**
 * 对 PostgreSQL 字符串字面量中的单引号加倍，供固定变量设置语句使用，不处理任意 SQL 标识符。
 */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * 把身份、租户、部门路径、范围 JSON 和明文能力编码成 set_config 调用。
 * false 表示会话级生效，空身份/部门编码为空字符串；调用方执行后负责连接归还和销毁。
 */
export function setSessionVarsSql(ctx: Ctx): string {
  const vars: [string, string][] = [
    ['app.user_id', ctx.userId ?? ctx.onBehalfOf ?? ''],
    ['app.tenant_id', ctx.tenantId],
    ['app.dept_id', ctx.deptId ?? ''],
    ['app.dept_path', ctx.deptPath ?? ''],
    ['app.scopes', scopesJson(ctx)],
    ['app.unmask', ctx.unmask.join(',')],
  ];
  return `select ${vars.map(([k, v]) => `set_config(${lit(k)}, ${lit(v)}, false)`).join(', ')}`;
}
