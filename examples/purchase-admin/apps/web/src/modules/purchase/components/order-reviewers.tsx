/**
 * 采购详情中的专业复核配置，申请人在草稿或退回后选择实际会签人。
 * 配置通过 setReviewers 命令保存，提交后只读；页面不能更改已经生成的审批实例快照。
 * 名录只用于展示与选人，服务端重查有效名录、提单人隔离、状态、版本及命令权限。
 */
import { useState } from 'react';
import { can, purchaseOrder, type PurchaseOrder } from '@app/contracts';
import { useCommand } from '../../../shared/hooks/use-command';
import { ApprovalMemberPicker, useApprovalMembers } from '../../../shared/ui/approval-member-picker';
import { Notice } from '../../../shared/ui/notice';

/**
 * order 为安全读取的最新单据；null 草稿表示未编辑，避免后台刷新覆盖用户尚未保存的选人。
 * 保存携带当前业务版本，成功清空本地草稿并刷新缓存；失败保留选择和提示，不重试写入。
 * 名录首页外或已不可读人员保留 UUID，不能把查不到名称解释为已删除或无需签署。
 */
export function OrderReviewers({ order }: { order: PurchaseOrder }) {
  const [draft, setDraft] = useState<{ enabled: boolean; ids: string[] } | null>(null);
  const members = useApprovalMembers(1, true);
  const { run, busy, message, clearMessage } = useCommand();
  const editable = order.status === 'draft' && can('PurchaseOrder.setReviewers');
  const selection = draft ?? { enabled: order.needsSpecialistReview ?? false, ids: order.reviewerIds ?? [] };
  const names = (order.reviewerIds ?? []).map(id => members.data?.items.find(member => member.userId === id)?.displayName ?? id);
  return <section className="purpose-editor">
    <h2>审批安排{draft && editable && <small className="muted"> · 尚未保存</small>}</h2>
    <p className="muted">{selection.enabled ? '需要所选专业人员全部签署。' : '本单不要求专业人员会签。'}具体流转与其他审批环节以提交后的流程记录为准。</p>
    {message && <Notice onClose={clearMessage}>{message}</Notice>}
    {editable ? <>
      <label className="review-checkbox"><input type="checkbox" checked={selection.enabled} disabled={busy}
        onChange={event => setDraft({ ...selection, enabled: event.target.checked })} />需要专业会签（技术、质量等）</label>
      {selection.enabled && <ApprovalMemberPicker value={selection.ids} onChange={ids => setDraft({ ...selection, ids })} exclude={[order.createdBy]} disabled={busy} />}
      <div className="actions"><span className="muted">退回后可重新安排，重提将开启新一轮审批。</span>
        <button disabled={busy || draft === null || (selection.enabled && !selection.ids.length)} onClick={async () => {
          if (await run(() => purchaseOrder.setReviewers(order.id, { needsSpecialistReview: selection.enabled, reviewerIds: selection.enabled ? selection.ids : [] }, order.version), '审批安排已保存')) setDraft(null);
        }}>保存审批安排</button></div>
    </> : <p>{order.needsSpecialistReview ? `专业会签：${names.join('、')}` : '无需专业会签'}</p>}
  </section>;
}
