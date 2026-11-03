// 采购页面拥有筛选、分页、新建和导出状态；其他模块不用了解这些实现细节。
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { can, client, purchaseOrder, usePurchaseOrderList, useTransfer } from '@app/contracts';
import { useCommand } from '../../../shared/hooks/use-command';
import { errorMessage } from '../../../shared/lib/error-message';
import { Notice } from '../../../shared/ui/notice';
import { PageHeading } from '../../../shared/ui/page-heading';
import { QueryFailure } from '../../../shared/ui/page-state';
import { PurchaseOrderForm } from '../components/purchase-order-form';
import { currency, statusLabels } from '../lib/presentation';

export function PurchaseOrdersPage({ pendingTasks }: { pendingTasks?: number }) {
  // 可分享、刷新恢复的列表条件进入 URL；弹窗和提交中的临时状态继续留在组件里。
  const [search, setSearch] = useSearchParams();
  const status = search.get('status') ?? '';
  const requestedPage = Number(search.get('page') ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  function filter(nextStatus: string, nextPage: number) {
    const params = new URLSearchParams(search);
    nextStatus ? params.set('status', nextStatus) : params.delete('status');
    nextPage === 1 ? params.delete('page') : params.set('page', String(nextPage));
    setSearch(params);
  }
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportError, setExportError] = useState('');
  const exportTask = useTransfer(exportId);
  const { run, busy, message, clearMessage } = useCommand();
  // 列表和统计来自服务端；待办数量由 app 组合层传入，采购模块不依赖审批页面。
  const orders = usePurchaseOrderList({ status, page, pageSize: 10, sort: '-createdAt' });
  async function exportCsv() {
    setExporting(true);
    setExportError('');
    const result = await purchaseOrder.export({ status });
    setExporting(false);
    if (result.ok) setExportId(result.data.id);
    else setExportError(errorMessage(result));
  }
  if (orders.isError)
    return (
      <QueryFailure
        error={orders.error}
        to="/workspace"
        label="返回工作台"
        retry={() => void orders.refetch()}
      />
    );
  return (
    <>
      <PageHeading eyebrow="PURCHASE ORDERS" title="采购单" description="每一张单据的进展，清晰可见。">
        {can('PurchaseOrder.create') && (
          <button className="primary" onClick={() => setCreating(true)}>
            ＋ 新建采购单
          </button>
        )}
      </PageHeading>
      {message && <Notice onClose={clearMessage}>{message}</Notice>}
      {exportError && <Notice onClose={() => setExportError('')}>{exportError}</Notice>}
      {exportId && (
        <div role="status" className="notice">
          {exportTask.isError ? (
            `导出状态读取失败：${exportTask.error.message}`
          ) : exportTask.data?.status === 'completed' ? (
            <a href={client.transferDownloadUrl(exportId)}>导出已完成，点击下载 CSV（24 小时内有效） ↗</a>
          ) : exportTask.data?.status === 'failed' ? (
            `导出失败：${exportTask.data.errorCode ?? '请重新尝试'}`
          ) : exportTask.data?.status === 'expired' ? (
            '导出文件已过期，请重新导出'
          ) : (
            '正在后台生成导出文件…'
          )}
          <button onClick={() => setExportId(null)} aria-label="关闭导出提示">
            ×
          </button>
        </div>
      )}
      <div className="summary">
        <div>
          <small>当前筛选单据</small>
          <strong>
            {orders.data?.total ?? '—'}
            <span> 单</span>
          </strong>
        </div>
        <div>
          <small>我的待办</small>
          <strong>
            {pendingTasks ?? '—'}
            <span> 项</span>
          </strong>
        </div>
        <div className="summary-note">
          <span>完整记录 · 每步可追溯</span>
          <p>
            提交、审批和同步进展
            <br />
            统一记录在单据中。
          </p>
        </div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <div className="filters">
            {[
              ['', '全部'],
              ['draft', '草稿'],
              ['pending_approval', '待审批'],
              ['approved', '已通过'],
              ['received', '已收货'],
            ].map(([value, label]) => (
              <button
                className={status === value ? 'active' : ''}
                key={value}
                onClick={() => {
                  filter(value, 1);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {can('PurchaseOrder.export') && (
            <button disabled={busy || exporting} onClick={exportCsv}>
              导出 CSV ↗
            </button>
          )}
        </div>
        {orders.isPending ? (
          <p className="empty">正在读取采购单…</p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>单据编号 / 创建时间</th>
                    <th>物料</th>
                    <th>采购金额</th>
                    <th>状态</th>
                    <th>ERP 单号</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.items.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <Link
                          className="record-link mono"
                          to={`/procurement/orders/${encodeURIComponent(order.id)}`}
                        >
                          PO-{order.id.slice(0, 8).toUpperCase()}
                        </Link>
                        <small>{new Date(order.createdAt).toLocaleString('zh-CN')}</small>
                      </td>
                      <td>{order.items.map((i) => `${i.sku} × ${i.qty}`).join('、')}</td>
                      <td className="amount">{currency(order.amount)}</td>
                      <td>
                        <span className={`badge ${order.status}`}>{statusLabels[order.status]}</span>
                      </td>
                      <td className="mono muted">{order.erpNo || '—'}</td>
                      <td>
                        <div className="actions">
                          {order.status === 'draft' && can('PurchaseOrder.submit') && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                run(() => purchaseOrder.submit(order.id, order.version), '已提交审批')
                              }
                            >
                              提交审批
                            </button>
                          )}
                          {['draft', 'pending_approval', 'approved'].includes(order.status) &&
                            can('PurchaseOrder.cancel') && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  run(() => purchaseOrder.cancel(order.id, order.version), '采购单已取消')
                                }
                              >
                                取消
                              </button>
                            )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!orders.data.items.length && (
              <div className="empty">
                <span className="empty-symbol">▤</span>
                <h3>暂无采购单</h3>
                <p>新建一张采购单，开始记录你的采购需求。</p>
              </div>
            )}
            <footer className="pagination">
              <span>
                共 {orders.data.total} 单 · 第 {page} 页
              </span>
              <div>
                <button disabled={page === 1} onClick={() => filter(status, page - 1)}>
                  上一页
                </button>
                <button disabled={page * 10 >= orders.data.total} onClick={() => filter(status, page + 1)}>
                  下一页
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
      {creating && <PurchaseOrderForm close={() => setCreating(false)} run={run} />}
    </>
  );
}
