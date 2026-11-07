import { createHash } from 'node:crypto';
import { cageError, stableStringify, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { approvalRoleContext } from '@yss123/cage-approval';
import { z } from 'zod';
import type { StoredRun } from './state.js';

export const digest = (value: unknown): string => createHash('sha256').update(stableStringify(value)).digest('hex');
export function authFingerprint(ctx: Ctx): string {
  return digest({
    tenant: ctx.tenantId,
    user: ctx.userId,
    actor: ctx.actor,
    dept: ctx.deptId,
    path: ctx.deptPath,
    capabilities: [...ctx.capabilities].sort(([a], [b]) => a.localeCompare(b)),
    scopes: ctx.scopes,
    unmask: [...ctx.unmask].sort(),
  });
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw cageError(
      'INVALID_INPUT',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return result.data;
}
export function needUser(ctx: Ctx): asserts ctx is Ctx & { userId: string } {
  if (ctx.actor?.kind !== 'user' || !ctx.userId) throw cageError('UNAUTHENTICATED');
  if (!ctx.capabilities.has('Sys.ai.use')) throw cageError('FORBIDDEN', { capability: 'Sys.ai.use' });
}
/** 每轮及每次动作重读授权；任务不携带可被模型篡改的权限快照。 */
export async function contextForRun(kernel: Kernel, run: StoredRun): Promise<Ctx> {
  if (new Date(run.delegated_until).getTime() <= Date.now()) throw cageError('UNAUTHENTICATED');
  if (run.mode === 'approval') return approvalRoleContext(kernel, run.process, run.tenant_id);
  if (run.auth_session) {
    const session = await kernel.app
      .selectFrom('sys.session')
      .select('id')
      .where('id', '=', run.auth_session)
      .where('tenant_id', '=', run.tenant_id)
      .where('user_id', '=', run.user_id)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!session) throw cageError('UNAUTHENTICATED');
  }
  const ctx = await kernel.contextFor(run.user_id, run.tenant_id, {
    requestId: run.id,
    source: 'api',
    stepUpAt: run.step_up_at ? Number(run.step_up_at) : null,
  });
  if (!ctx) throw cageError('UNAUTHENTICATED');
  needUser(ctx);
  return ctx;
}
