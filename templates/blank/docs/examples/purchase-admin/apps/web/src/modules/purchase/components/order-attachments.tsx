/**
 * 采购详情的附件展示与草稿编辑区，将上传准备和领域关联保存明确分开。
 * 读取到新版本后重新采用服务端附件列表并收起编辑，避免旧草稿覆盖已变化记录。
 */
import { useEffect, useState } from 'react';
import { can, purchaseOrder, PurchaseOrderFileFields, type PurchaseOrder } from '@app/contracts';
import { AttachmentUpload, FileLink } from '../../../shared/ui/attachment-upload';
import { useCommand } from '../../../shared/hooks/use-command';

/**
 * order 为已读取的采购记录，包含版本、状态和已绑定附件 ID。
 * 仅草稿且具有 setAttachments 能力时显示编辑入口；保存传入 id 与 version，服务端重新校验。
 * value 是临时选择列表，移除或上传不会自动修改单据；成功后的缓存刷新带回正式结果。
 */
export function OrderAttachments({ order }: { order: PurchaseOrder }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(order.attachments);
  const [uploading, setUploading] = useState(false);
  const { run, busy, message } = useCommand();
  useEffect(() => { setValue(order.attachments); setEditing(false); }, [order.version, order.attachments]);
  return <section aria-label="采购附件">
    <div className="section-head"><h2>采购附件</h2>{order.status === 'draft' && can('PurchaseOrder.setAttachments') && <button type="button" onClick={() => setEditing(!editing)}>{editing ? '收起编辑' : '编辑附件'}</button>}</div>
    {editing ? <>
      <AttachmentUpload command="PurchaseOrder.setAttachments" field="attachments" targetId={order.id} policy={PurchaseOrderFileFields.attachments} value={value} onChange={setValue} onBusyChange={setUploading} />
      <button type="button" disabled={uploading || busy} onClick={() => run(() => purchaseOrder.setAttachments(order.id, { attachments: value }, order.version), '附件已保存')}>保存附件</button>
      {message && <p role="status">{message}</p>}
    </> : order.attachments.length ? <ul>{order.attachments.map(id => <li key={id}><FileLink id={id} /></li>)}</ul> : <p className="muted">暂无附件</p>}
  </section>;
}
