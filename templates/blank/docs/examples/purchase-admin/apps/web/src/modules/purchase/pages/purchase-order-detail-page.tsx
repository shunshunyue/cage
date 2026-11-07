// 详情通过 URL 中的记录 ID 重新读取安全接口；刷新或新标签页不依赖列表的内存状态。
import { Link, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { can, PurchaseOrderSchema, purchaseOrder, usePurchaseOrder } from '@app/contracts';
import { useCommand } from '../../../shared/hooks/use-command';
import { PageState, QueryFailure } from '../../../shared/ui/page-state';
import { PageHeading } from '../../../shared/ui/page-heading';
import { Notice } from '../../../shared/ui/notice';
import { currency, statusLabels } from '../lib/presentation';
import { OrderAttachments } from '../components/order-attachments';
import { PurchaseAssistantContext } from '../components/purchase-assistant-context';
import { ApprovalHistory } from '../components/approval-history';
import './purchase-intelligence.css';

const list = '/procurement/orders';

export function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const parsed = PurchaseOrderSchema.shape.id.safeParse(id);
  if (!parsed.success)
    return <PageState title="单据地址无效" description="请从采购单列表选择有效单据。" to={list} />;
  return <OrderDetail key={parsed.data} id={parsed.data} />;
}

function OrderDetail({ id }: { id: string }) {
  const query = usePurchaseOrder(id);
  const [draftReason, setDraftReason] = useState<string | null>(null);
  useEffect(() => {
    if (query.data?.status !== 'pending_approval') return;
    const timer = setInterval(() => void query.refetch(), 1500);
    return () => clearInterval(timer);
  }, [query.data?.status, query.refetch]);
  const { run, busy, message, clearMessage } = useCommand();
  if (query.isPending)
    return (
      <p className="empty" role="status">
        正在读取采购单…
      </p>
    );
  if (query.isError) return <QueryFailure error={query.error} to={list} retry={() => void query.refetch()} />;
  const order = query.data;
  return (
    <>
      <PageHeading
        eyebrow={`PO-${order.id.slice(0, 8).toUpperCase()}`}
        title="采购单详情"
        description="单据内容与最新状态，以服务端记录为准。"
      >
        <Link className="route-link" to={list}>
          ← 返回采购单
        </Link>
      </PageHeading>
      {message && <Notice onClose={clearMessage}>{message}</Notice>}
      <div className="purchase-detail-content"><section className="panel">
        <div className="section-head">
          <span className={`badge ${order.status}`}>{statusLabels[order.status]}</span>
          <div className="actions">
            {order.status === 'draft' && can('PurchaseOrder.submit') && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => run(() => purchaseOrder.submit(id, order.version), '已提交审批')}
              >
                提交审批
              </button>
            )}
            {['draft', 'pending_approval', 'approved'].includes(order.status) &&
              can('PurchaseOrder.cancel') && (
                <button
                  disabled={busy}
                  onClick={() => run(() => purchaseOrder.cancel(id, order.version), '采购单已取消')}
                >
                  取消采购单
                </button>
              )}
          </div>
        </div>
        <dl className="record-facts">
          <div>
            <dt>采购金额</dt>
            <dd className="amount">{currency(order.amount)}</dd>
          </div>
          <div>
            <dt>ERP 单号</dt>
            <dd>{order.erpNo ?? '尚未同步'}</dd>
          </div>
          <div>
            <dt>供应商电话</dt>
            <dd>{order.supplierPhone ?? '未填写'}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{new Date(order.createdAt).toLocaleString('zh-CN')}</dd>
          </div>
          <div>
            <dt>单据 ID</dt>
            <dd className="mono">{order.id}</dd>
          </div>
          <div>
            <dt>当前版本</dt>
            <dd>{order.version}</dd>
          </div>
        </dl>
        <div className="purpose-editor"><label htmlFor="purchase-purpose">采购用途与必要性</label>
          {order.status === 'draft' && can('PurchaseOrder.explainPurpose') ? <>
            <textarea id="purchase-purpose" rows={4} maxLength={2000} value={draftReason ?? order.reason ?? ''} onChange={e => setDraftReason(e.target.value)} placeholder="说明用于什么工作、需要哪些物料以及采购原因" />
            <div className="actions"><small className="muted">助理可检查此处尚未保存的内容。</small><button disabled={busy || draftReason === null || !draftReason.trim()} onClick={async () => {
              if (await run(() => purchaseOrder.explainPurpose(id, { reason: draftReason! }, order.version), '采购用途已保存')) setDraftReason(null);
            }}>保存用途</button></div>
          </> : <p>{order.reason || '尚未填写用途'}</p>}
        </div>
        <OrderAttachments order={order} />
        <div className="section-head">
          <h2>采购物料</h2>
          <span className="muted">{order.items.length} 项</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>物料编码</th>
              <th>采购数量</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item, index) => (
              <tr key={`${item.sku}-${index}`}>
                <td className="mono">{item.sku}</td>
                <td>{item.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <ApprovalHistory id={id} version={order.version} pending={order.status === 'pending_approval'} /></div>
      <PurchaseAssistantContext context={{ page: { id: 'purchase-order-detail', title: '采购单详情', kind: 'detail', route: `/procurement/orders/${id}` },
        subject: { aggregate: 'PurchaseOrder', id, observedVersion: order.version },
        ...(draftReason !== null && order.status === 'draft' ? { draft: { command: 'PurchaseOrder.explainPurpose', values: { reason: draftReason }, baseVersion: order.version } } : {}),
      }} suggestions={['检查当前采购用途是否符合审核要求', '这张采购单现在到哪一步了？', '帮我提交当前采购单']} />
    </>
  );
}
