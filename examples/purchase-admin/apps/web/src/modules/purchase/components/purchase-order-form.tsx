/**
 * 采购草稿创建表单，收集物料、数量、元金额字符串、用途、电话和已上传附件。
 * 创建人、部门和初始状态由领域及内核确定；浏览器表单限制只承担输入体验。
 */
// 只处理采购草稿输入；状态迁移、创建人和权限仍由领域命令决定。
import { useState, type FormEvent } from 'react';
import { purchaseOrder, PurchaseOrderFileFields, currentUser } from '@app/contracts';
import type { RunCommand } from '../../../shared/hooks/use-command';
import { AttachmentUpload } from '../../../shared/ui/attachment-upload';
import './purchase-order-form.css';
import { ApprovalMemberPicker } from '../../../shared/ui/approval-member-picker';

/**
 * 在弹窗中维护附件列表、上传状态和提交状态。
 * close 由列表控制弹窗关闭；run 使用 useCommand 协议返回成功布尔值，失败保留输入。
 * 上传中的文件不能随表单提交，上传完成仍需 create 命令正式绑定。
 */
export function PurchaseOrderForm({ close, run }: { close: () => void; run: RunCommand }) {
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [needsSpecialistReview, setNeedsSpecialistReview] = useState(false);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  /**
   * 读取 FormData 并构造创建输入：金额保留字符串，数量转数值，可选空文本转 undefined。
   * 等待 run 返回后解除提交态，只有成功才关闭；依赖 run 返回结果，不额外捕获任意抛出异常。
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading || busy) return;
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const ok = await run(
      () =>
        purchaseOrder.create({
          amount: String(data.get('amount')),
          supplierPhone: String(data.get('phone')) || undefined,
          reason: String(data.get('reason')) || undefined,
          items: [{ sku: String(data.get('sku')), qty: Number(data.get('qty')) }],
          attachments,
          needsSpecialistReview, reviewerIds: needsSpecialistReview ? reviewerIds : [],
        }),
      '采购单已保存为草稿',
    );
    setBusy(false);
    if (ok) close();
  }
  return (
    <div className="modal-backdrop">
      <section role="dialog" aria-modal="true" aria-labelledby="new-order-title" className="modal purchase-order-dialog">
        <div className="section-head">
          <h2 id="new-order-title">新建采购单</h2>
          <button onClick={close} aria-label="关闭">
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          <label>
            物料编码
            <input name="sku" placeholder="例如 A-01" required autoFocus maxLength={64} />
          </label>
          <div className="form-row">
            <label>
              数量
              <input name="qty" type="number" min="1" step="1" defaultValue="1" required />
            </label>
            <label>
              采购金额（元）
              <input name="amount" type="number" min="0.01" step="0.01" required />
            </label>
          </div>
          <label>
            供应商电话
            <input name="phone" type="tel" maxLength={32} />
          </label>
          <p className="muted">保存后可在列表提交审批，创建人和部门会自动填写。</p>
          <label>采购用途与必要性<textarea name="reason" rows={3} maxLength={2000} placeholder="说明具体用途；提交后先进行 AI 材料预审" /></label>
          <label className="review-checkbox"><input type="checkbox" checked={needsSpecialistReview} onChange={event => setNeedsSpecialistReview(event.target.checked)} />需要专业会签（技术、质量等）</label>
          {needsSpecialistReview && <ApprovalMemberPicker value={reviewerIds} onChange={setReviewerIds} exclude={currentUser() ? [currentUser()!.id] : []} disabled={busy} />}
          <p className="muted">{needsSpecialistReview ? '所选专业人员需要全部签署。' : '本次不要求专业会签。'}提交后可在审批记录查看实际环节和办理进度。</p>
          <AttachmentUpload command="PurchaseOrder.create" field="attachments" policy={PurchaseOrderFileFields.attachments} value={attachments} onChange={setAttachments} onBusyChange={setUploading} />
          <button className="primary" disabled={busy || uploading || (needsSpecialistReview && reviewerIds.length === 0)}>
            {busy ? '保存中…' : '保存草稿'}
          </button>
        </form>
      </section>
    </div>
  );
}
