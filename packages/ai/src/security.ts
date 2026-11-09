/**
 * AI 的输入与身份边界。提交、轮次恢复和工具执行共享这里的校验。
 * 权限摘要用于发现变化，不是授权凭证；后台恢复仍核验登录会话、委托期限与内核当前权限。
 */
import { createHash } from 'node:crypto';
import { cageError, stableStringify, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { approvalRoleContext } from '@yss123/cage-approval';
import { z } from 'zod';
import type { StoredRun } from './state.js';

/**
 * 稳定序列化后计算 SHA-256 摘要，用于输入/状态比较，不用于保存密码。
 */
export const digest = (value: unknown): string => createHash('sha256').update(stableStringify(value)).digest('hex');
/**
 * 把主体、部门、能力参数、范围和明文权限纳入指纹，防止交付旧授权下的上下文。
 */
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
/**
 * 按 Zod 校验并返回转换后的输入；失败转为带字段路径的 INVALID_INPUT。
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw cageError(
      'INVALID_INPUT',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return result.data;
}
/**
 * 要求真人用户及 Sys.ai.use；失败抛未登录或无权限错误，并将 userId 收窄为字符串。
 */
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
