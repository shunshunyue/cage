// 只处理采购草稿输入；状态迁移、创建人和权限仍由领域命令决定。
import { useState, type FormEvent } from 'react';
import { purchaseOrder, PurchaseOrderFileFields } from '@app/contracts';
import type { RunCommand } from '../../../shared/hooks/use-command';
import { AttachmentUpload } from '../../../shared/ui/attachment-upload';
import './purchase-order-form.css';

export function PurchaseOrderForm({ close, run }: { close: () => void; run: RunCommand }) {
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
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
          <AttachmentUpload command="PurchaseOrder.create" field="attachments" policy={PurchaseOrderFileFields.attachments} value={attachments} onChange={setAttachments} onBusyChange={setUploading} />
          <button className="primary" disabled={busy || uploading}>
            {busy ? '保存中…' : '保存草稿'}
          </button>
        </form>
      </section>
    </div>
  );
}
