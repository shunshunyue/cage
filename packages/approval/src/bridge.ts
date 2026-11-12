// 桥接：引擎的结论只能转成命令，以流程身份调用，走完整 12 关。引擎侧没有任何业务表的数据库权限。
import { cageError, loadUserGrants, userCtx, type Ctx, type Kernel } from '@yss123/cage-kernel';
import type { Transaction } from 'kysely';
import type { ApprovalAdapter, ApprovalOutcome } from './types.js';
import { approvalRoleContext } from './ai.js';

/**
 * 从流程绑定选择通过/驳回/退回命令，再为结论构造可信 process 上下文。
 * 人工结论实时核对最后审批人的命令能力与单据可见性；自动结论使用受限角色，不能继承系统全部范围。
 * 传 tx 时与待办决定共同回滚，未传时命令自行开事务；expectedVersion 阻止迟到结论覆盖新版本。
 */
export async function applyOutcome(k: Kernel, r: ApprovalOutcome, tx?: Transaction<any>): Promise<Record<string, any>> {
  const binding = k.registry.approvalByProcess(r.process);
  if (!binding) throw new Error(`[CAGE-APPR-004] 没有流程 ${r.process} 的审批绑定`);
  const cmd = r.outcome === 'approved' ? binding.a.onApproved : r.outcome === 'returned' ? binding.a.onReturned : binding.a.onRejected;
  if (!cmd) throw new Error('[CAGE-APPR-006] 审批未绑定退回修改命令');
  let ctx: Ctx;
  if (r.lastApprover) {
    // 待办决定已持有事务连接时复用它；同实例并发排队不能耗尽池后让锁持有者再等新连接。
    const grants = await loadUserGrants(tx ?? k.app, r.lastApprover, r.tenantId, k.catalogCaps());
    const user = grants ? userCtx(grants) : null;
    if (!user?.capabilities.has(k.registry.capabilityOf(cmd)) || !user.capabilities.has(`${binding.a.agg.name}.read`)) throw cageError('FORBIDDEN');
    // 先核验真人对目标单据的权限；命令内声明的后台读依赖仍按已有流程身份完成业务校验。
    const visible = await k.read.tx(user, read => read.selectFrom(`safe.${binding.a.agg.table.name}`).select('id').where('id', '=', r.businessKey).executeTakeFirst());
    if (!visible) throw cageError('NOT_FOUND');
    ctx = k.processCtx({ process: r.process, tenantId: r.tenantId, onBehalfOf: r.lastApprover, capabilities: [k.registry.capabilityOf(cmd)] });
  } else ctx = await approvalRoleContext(k, r.process, r.tenantId);
  const input = { id: r.businessKey, expectedVersion: r.expectedVersion };
  return tx ? k.executeIn(tx, cmd, input, ctx, 0) : k.execute(cmd, input, ctx);
}

/** 外部引擎（例如独立部署的 Warm-Flow、Flowable 服务）：它的结论通过回调进入这里 */
/** 只登记结束回调，不创建外部流程或授予回调来源信任；适配器须自行完成其协议认证和投递可靠性。 */
export function bindApproval(adapter: ApprovalAdapter, k: Kernel): void {
  adapter.onCompleted(async (r) => {
    await applyOutcome(k, r);
  });
}
