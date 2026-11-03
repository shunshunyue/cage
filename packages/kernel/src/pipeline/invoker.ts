import { cageError } from '../errors.js';
import type { AnyCommand } from '../primitives/command.js';
import type { Ctx } from '../types.js';

/** 实际执行与权限解释共享调用身份判断，防止诊断给出另一套结论。 */
export function assertInvoker(cmd: AnyCommand, ctx: Ctx, capability: string): void {
  const kind = ctx.actor!.kind;
  if (kind === 'system') return;
  if (kind === 'user' || kind === 'anonymous') {
    if (!cmd.invokedBy.includes('user')) throw cageError('FORBIDDEN', { capability, message: `该命令只接受 ${cmd.invokedBy.join('/')} 调用` });
    return;
  }
  const as = kind === 'reaction' ? 'process' : kind;
  if (!cmd.invokedBy.includes('user') && !cmd.invokedBy.includes(as as any)) throw cageError('FORBIDDEN', { capability, message: `${kind} 身份不能调用该命令` });
}
