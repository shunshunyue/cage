/**
 * 采购单审批轨迹展示，按单据与版本读取服务端整理后的轮次和步骤。
 * AI 与人工状态使用同一记录来源；并行节点按服务端分支路径展示，序号仅定位节点、不代表串行先后。
 * 受限详情不显示理由，不能根据缺少细节推断未执行；该组件只消费框架历史，不实现审批调度。
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { client } from '@yss123/cage-client';
import { useApprovalMembers } from '../../../shared/ui/approval-member-picker';

/** 人工操作与引擎自动激活都来自已提交历史；未知动作保留原值，不能伪装成通过。 */
const actionLabels: Record<string, string> = { transfer: '转办', delegate: '委派协助', resolve: '归还审批人', addSign: '增加签署人', claim: '领取任务', unclaim: '释放任务', approved: '通过审批', rejected: '驳回', returned: '退回修改', cancelled: '取消流程', activated: '激活等待任务', skipped: '结束其余待办', advanced: '推进审批分支', urged: '申请人催办', reminded: '流程时限提醒' };
const positionLabels: Record<string, string> = { before: '前加签', after: '后加签', parallel: '并行加签' };

/**
 * 运行、步骤与人工待办状态的展示映射，未知状态仍由页面按实际值处理。
 */
const status: Record<string, string> = { queued: '待执行', running: '处理中', passed: '已通过', approved: '已通过', returned: '已退回修改', rejected: '已拒绝', manual: '待人工接管', waiting_manual: '待人工接管', waiting: '待人工审批', cancelled: '已取消', failed: '执行失败', pending: '待处理', skipped: '未执行' };
/**
 * id 为采购单标识，version 使业务变更后查询重新取数，pending 决定是否每 1500ms 刷新。
 * 只显示历史，不执行审批；detailRestricted 分支尊重服务端裁剪，人工接管也不等于通过。
 */
export function ApprovalHistory({ id, version, pending }: { id: string; version: number; pending: boolean }) {
  const history = useQuery({ queryKey: ['approval-history', id, version], queryFn: async () => {
    const result = await client.approvalHistory('PurchaseOrder', id);
    if (!result.ok) throw new Error(`审批记录读取失败：${result.code}`);
    return result.data;
  }, refetchInterval: pending ? 1500 : false });
  const members = useApprovalMembers(1, true);
  // 跨轮次动作按服务端游标递增分页；轮询重读已经打开的页，避免只更新首屏或丢失后续意见。
  const actions = useInfiniteQuery({ queryKey: ['approval-task-history', id], initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const result = await client.approvalTaskHistory('po-approval', 'PurchaseOrder', id, { after: pageParam, limit: 50 });
      if (!result.ok) throw new Error(`操作记录读取失败：${result.code}`);
      return result.data;
    }, getNextPageParam: last => last.nextCursor ?? undefined, refetchInterval: pending ? 1500 : false });
  const person = (userId: string | null) => userId ? members.data?.items.find(member => member.userId === userId)?.displayName ?? userId.slice(0, 8) : '系统';
  return <section className="panel approval-history"><div className="section-head"><h2>审批记录</h2><span className="muted">退回后重新提交，从第一步重新审核</span></div>
    {history.isPending && <p className="muted">正在读取审核记录…</p>}
    {history.isError && <p role="alert">{history.error.message}</p>}
    {history.data?.length === 0 && <p className="muted">提交后按已配置流程审批，实际环节和并行分支将在此显示。</p>}
    {history.data?.map((round, index) => <div className="review-round" key={round.id}><h3>第 {history.data.length - index} 轮 · {status[round.status] ?? round.status}</h3>
      {(round.currentSteps?.length ?? 0) > 1 && <p className="muted">当前有 {round.currentSteps!.length} 个审批环节并行办理，全部完成后才继续。</p>}
      {round.steps.map(step => <div className="review-step" key={step.index}><strong>{step.index + 1}. {step.title ?? (step.kind === 'ai' ? 'AI 材料预审' : '人工审批')} · {status[step.status] ?? step.status}</strong>
        {!!step.branchPath?.length && <p className="muted">{step.branchPath.map(part => `${part.parallel} · ${part.branch}`).join(' / ')}</p>}
        {step.detailRestricted ? <p>当前权限无法查看审核解释。</p> : <>{step.decision && <p>{step.decision.reason}</p>}{step.decision?.suggestions.map((text, i) => <p className="review-suggestion" key={i}>{text}</p>)}</>}
      </div>)}
    </div>)}
    <div className="review-actions"><h3>人员流转与处理意见</h3>
      {actions.isPending && <p role="status">正在读取操作记录…</p>}
      {actions.isError && <p role="alert">{actions.error.message} <button onClick={() => void actions.refetch()}>重试</button></p>}
      {actions.data?.pages.flatMap(page => page.items).map(item => {
        const placement = typeof item.details.placement === 'string' ? positionLabels[item.details.placement] : undefined;
        const targets = Array.isArray(item.details.userIds) ? item.details.userIds.filter((value): value is string => typeof value === 'string') : [];
        const to = typeof item.details.to === 'string' ? item.details.to : null;
        const roundIndex = history.data?.findIndex(round => round.id === item.instanceId) ?? -1;
        return <article className="review-step" key={item.id}>
          <strong>{person(item.actorId)} · {placement ?? actionLabels[item.action] ?? item.action}</strong>
          <small className="muted">{roundIndex >= 0 ? `第 ${history.data!.length - roundIndex} 轮 · ` : ''}{new Date(item.createdAt).toLocaleString('zh-CN')}</small>
          {targets.length > 0 ? <p>签署人：{targets.map(person).join('、')}</p> : to && ['transfer', 'delegate', 'resolve'].includes(item.action) ? <p>交给：{person(to)}</p> : null}
          {item.reason && <p>{item.reason}</p>}
        </article>;
      })}
      {actions.data?.pages[0].items.length === 0 && <p className="muted">尚无人工操作记录。</p>}
      {actions.hasNextPage && <button disabled={actions.isFetchingNextPage} onClick={() => void actions.fetchNextPage()}>加载后续记录</button>}
    </div>
  </section>;
}
