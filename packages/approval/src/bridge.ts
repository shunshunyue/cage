// 桥接：引擎的结论只能转成命令，以流程身份调用，走完整 12 关。引擎侧没有任何业务表的数据库权限。
import type { Kernel } from '@yss123/cage-kernel';
import type { Transaction } from 'kysely';
import type { ApprovalAdapter, ApprovalOutcome } from './types.js';

export async function applyOutcome(k: Kernel, r: ApprovalOutcome, tx?: Transaction<any>): Promise<Record<string, any>> {
  const binding = k.registry.approvalByProcess(r.process);
  if (!binding) throw new Error(`[CAGE-APPR-004] 没有流程 ${r.process} 的审批绑定`);
  const cmd = r.outcome === 'approved' ? binding.a.onApproved : binding.a.onRejected;
  const ctx = k.processCtx({
    process: r.process,
    tenantId: r.tenantId,
    onBehalfOf: r.lastApprover,
    capabilities: [k.registry.capabilityOf(binding.a.onApproved), k.registry.capabilityOf(binding.a.onRejected)],
  });
  return tx ? k.executeIn(tx, cmd, { id: r.businessKey }, ctx, 0) : k.execute(cmd, { id: r.businessKey }, ctx);
}

/** 外部引擎（例如独立部署的 Warm-Flow、Flowable 服务）：它的结论通过回调进入这里 */
export function bindApproval(adapter: ApprovalAdapter, k: Kernel): void {
  adapter.onCompleted(async (r) => {
    await applyOutcome(k, r);
  });
}
