import { useQuery } from '@tanstack/react-query';
import { client } from '@yss123/cage-client';

const status: Record<string, string> = { queued: '待执行', running: '处理中', passed: '已通过', approved: '已通过', returned: '已退回修改', rejected: '已拒绝', manual: '待人工接管', waiting_manual: '待人工接管', waiting: '待人工审批', cancelled: '已取消', failed: '执行失败', pending: '待处理', skipped: '未执行' };
export function ApprovalHistory({ id, version, pending }: { id: string; version: number; pending: boolean }) {
  const history = useQuery({ queryKey: ['approval-history', id, version], queryFn: async () => {
    const result = await client.approvalHistory('PurchaseOrder', id);
    if (!result.ok) throw new Error(`审批记录读取失败：${result.code}`);
    return result.data;
  }, refetchInterval: pending ? 1500 : false });
  return <section className="panel approval-history"><div className="section-head"><h2>审批记录</h2><span className="muted">退回后重新提交，从第一步重新审核</span></div>
    {history.isPending && <p className="muted">正在读取审核记录…</p>}
    {history.isError && <p role="alert">{history.error.message}</p>}
    {history.data?.length === 0 && <p className="muted">提交后先进入 AI 材料预审，再按流程交由人工审批。</p>}
    {history.data?.map((round, index) => <div className="review-round" key={round.id}><h3>第 {history.data.length - index} 轮 · {status[round.status] ?? round.status}</h3>
      {round.steps.map(step => <div className="review-step" key={step.index}><strong>{step.index + 1}. {step.kind === 'ai' ? 'AI 材料预审' : '人工审批'} · {status[step.status] ?? step.status}</strong>
        {step.detailRestricted ? <p>当前权限无法查看审核解释。</p> : <>{step.decision && <p>{step.decision.reason}</p>}{step.decision?.suggestions.map((text, i) => <p className="review-suggestion" key={i}>{text}</p>)}</>}
      </div>)}
    </div>)}
  </section>;
}
