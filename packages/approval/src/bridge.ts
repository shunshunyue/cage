// 桥接：引擎的结论只能转成命令，以流程身份调用，走完整 12 关。引擎侧没有任何业务表的数据库权限。
import { cageError, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { Transaction } from 'kysely';
import type { ApprovalAdapter, ApprovalOutcome } from './types.js';
import { approvalRoleContext } from './ai.js';

export async function applyOutcome(k: Kernel, r: ApprovalOutcome, tx?: Transaction<any>): Promise<Record<string, any>> {
  const binding = k.registry.approvalByProcess(r.process);
  if (!binding) throw new Error(`[CAGE-APPR-004] 没有流程 ${r.process} 的审批绑定`);
  const cmd = r.outcome === 'approved' ? binding.a.onApproved : r.outcome === 'returned' ? binding.a.onReturned : binding.a.onRejected;
  if (!cmd) throw new Error('[CAGE-APPR-006] 审批未绑定退回修改命令');
  let ctx: Ctx;
  if (r.lastApprover) {
    const user = await k.contextFor(r.lastApprover, r.tenantId);
    if (!user?.capabilities.has(k.registry.capabilityOf(cmd))) throw cageError('FORBIDDEN');
    // 先核验真人对目标单据的权限；命令内声明的后台读依赖仍按已有流程身份完成业务校验。
    await k.read.get(binding.a.agg, r.businessKey, user);
    ctx = k.processCtx({ process: r.process, tenantId: r.tenantId, onBehalfOf: r.lastApprover, capabilities: [k.registry.capabilityOf(cmd)] });
  } else ctx = await approvalRoleContext(k, r.process, r.tenantId);
  const input = { id: r.businessKey, expectedVersion: r.expectedVersion };
  return tx ? k.executeIn(tx, cmd, input, ctx, 0) : k.execute(cmd, input, ctx);
}

/** 外部引擎（例如独立部署的 Warm-Flow、Flowable 服务）：它的结论通过回调进入这里 */
export function bindApproval(adapter: ApprovalAdapter, k: Kernel): void {
  adapter.onCompleted(async (r) => {
    await applyOutcome(k, r);
  });
}
