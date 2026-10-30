// 会话变量：内核在事务开始时写入当前主体，安全视图和行级策略读取它们。
// set_config 的第三个参数 true 表示只在本事务内有效，事务结束自动清空；忘了设置时一条都查不到。
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Ctx } from '../types.js';

export function scopesJson(ctx: Ctx): string {
  const out: Record<string, { c: string; deptIds?: string[] }[]> = {};
  for (const [agg, grants] of Object.entries(ctx.scopes)) {
    out[agg] = grants.map((g) => (g.deptIds ? { c: g.combinator, deptIds: g.deptIds } : { c: g.combinator }));
  }
  return JSON.stringify(out);
}

export async function setSessionVars(tx: Transaction<any> | Kysely<any>, ctx: Ctx, local = true): Promise<void> {
  await sql`select
    set_config('app.user_id',   ${ctx.userId ?? ctx.onBehalfOf ?? ''}, ${local}),
    set_config('app.tenant_id', ${ctx.tenantId}, ${local}),
    set_config('app.dept_id',   ${ctx.deptId ?? ''}, ${local}),
    set_config('app.dept_path', ${ctx.deptPath ?? ''}, ${local}),
    set_config('app.scopes',    ${scopesJson(ctx)}, ${local}),
    set_config('app.unmask',    ${ctx.unmask.join(',')}, ${local})`.execute(tx);
}
