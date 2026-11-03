// 详情通过 URL 中的记录 ID 重新读取安全接口；刷新或新标签页不依赖列表的内存状态。
import { Link, useParams } from 'react-router-dom';
import { can, PurchaseOrderSchema, purchaseOrder, usePurchaseOrder } from '@app/contracts';
import { useCommand } from '../../../shared/hooks/use-command';
import { PageState, QueryFailure } from '../../../shared/ui/page-state';
import { PageHeading } from '../../../shared/ui/page-heading';
import { Notice } from '../../../shared/ui/notice';
import { currency, statusLabels } from '../lib/presentation';
import { OrderAttachments } from '../components/order-attachments';

const list = '/procurement/orders';

export function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const parsed = PurchaseOrderSchema.shape.id.safeParse(id);
  if (!parsed.success)
    return <PageState title="单据地址无效" description="请从采购单列表选择有效单据。" to={list} />;
  return <OrderDetail id={parsed.data} />;
}

function OrderDetail({ id }: { id: string }) {
  const query = usePurchaseOrder(id);
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
      <section className="panel">
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
    </>
  );
}
