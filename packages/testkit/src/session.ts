// 会话级（不是事务级）的会话变量：用于模拟「拿着读侧连接直接写裸 SQL」。
import type { Ctx } from '@yss123/cage-kernel';
import { scopesJson } from '@yss123/cage-kernel/db';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

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
