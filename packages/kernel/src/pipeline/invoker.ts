/** 调用身份是独立于能力点和数据范围的一道边界；实际执行与只读解释共用此实现。 */
import { cageError } from '../errors.js';
import type { AnyCommand } from '../primitives/command.js';
import type { Ctx } from '../types.js';

/** 实际执行与权限解释共享调用身份判断，防止诊断给出另一套结论。 */
/**
 * 要求调用者已经完成 actor 存在性检查。系统身份是框架特权通道；reaction 按 process 语义检查。
 * 用户/匿名请求不能直接调用仅供流程、任务或外部回调的命令；不满足时抛 FORBIDDEN。
 * 通过本检查仍必须继续能力和范围校验，不能把 invokedBy 当作角色授权。
 */
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
