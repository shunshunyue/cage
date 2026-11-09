// 会话变量：内核在事务开始时写入当前主体，安全视图和行级策略读取它们。
// set_config 的第三个参数 true 表示只在本事务内有效，事务结束自动清空；忘了设置时一条都查不到。
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Ctx } from '../types.js';

/** 把内存 ScopeGrant 压缩成数据库函数约定的 c/deptIds 格式，不改变多角色 OR 语义。 */
export function scopesJson(ctx: Ctx): string {
  const out: Record<string, { c: string; deptIds?: string[] }[]> = {};
  for (const [agg, grants] of Object.entries(ctx.scopes)) {
    out[agg] = grants.map((g) => (g.deptIds ? { c: g.combinator, deptIds: g.deptIds } : { c: g.combinator }));
  }
  return JSON.stringify(out);
}

/**
 * 为安全视图设置当前租户、真人、部门、范围和明文种类；所有值参数化传递。
 * 生产路径应在事务内使用默认 local=true，保证连接归还池后不会遗留前一用户身份。
 * local=false 仅适合明确管理连接生命周期的工具/测试，调用者必须承担会话清理责任。
 */
export async function setSessionVars(tx: Transaction<any> | Kysely<any>, ctx: Ctx, local = true): Promise<void> {
  await sql`select
    set_config('app.user_id',   ${ctx.userId ?? ctx.onBehalfOf ?? ''}, ${local}),
    set_config('app.tenant_id', ${ctx.tenantId}, ${local}),
    set_config('app.dept_id',   ${ctx.deptId ?? ''}, ${local}),
    set_config('app.dept_path', ${ctx.deptPath ?? ''}, ${local}),
    set_config('app.scopes',    ${scopesJson(ctx)}, ${local}),
    set_config('app.unmask',    ${ctx.unmask.join(',')}, ${local})`.execute(tx);
}
