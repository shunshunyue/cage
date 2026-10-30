// 前端仅依赖生成契约。按钮显隐用于交互，真正的授权仍由后端命令流水线执行。
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  can,
  client,
  currentUser,
  loadMe,
  purchaseOrder,
  inventory,
  usePurchaseOrderList,
  useInventoryList,
  type CageResult,
  type PurchaseOrder,
} from '@app/contracts';
import './style.css';

const queryClient = new QueryClient();
const statusLabels: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已通过',
  received: '已收货',
  rejected: '已驳回',
  cancelled: '已取消',
};
const currency = (value: string) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(Number(value));

/** 将框架错误码转换成操作提示，保留 requestId 供用户向维护人员反馈。 */
function errorMessage(r: Extract<CageResult<unknown, string>, { ok: false }>): string {
  const labels: Record<string, string> = {
    FORBIDDEN: '你没有执行此操作的权限',
    INVALID_INPUT: '请检查填写内容',
    CONFLICT: '单据已更新，请刷新后重试',
    UNAUTHENTICATED: '登录已过期',
    CONSTRAINT_VIOLATED: '未满足审批条件，请检查审批人或额度',
    STOCK_SHORT: '库存不足',
    NETWORK: '连接失败，请稍后重试',
  };
  return `${labels[r.domainCode ?? r.code] ?? r.domainCode ?? r.code}${r.requestId ? ` · 请求 ${r.requestId.slice(0, 8)}` : ''}`;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const result = await client.login(String(data.get('username')), String(data.get('password')));
    setBusy(false);
    if (result.ok) onLogin();
    else setError(errorMessage(result));
  }
  return (
    <main className="login">
      <div className="login-intro">
        <span className="eyebrow">CAGE / OPERATIONS</span>
        <h1>
          每一笔采购，
          <br />
          有据可循。
        </h1>
        <p>
          从需求到审批，再到入库。
          <br />
          让团队在同一张工作台上协作。
        </p>
        <span className="edition">采购管理 · 示例工作台 / 01</span>
      </div>
      <form onSubmit={submit} className="login-form">
        <span className="eyebrow">WELCOME BACK</span>
        <h2>登录工作台</h2>
        <p className="muted">使用管理员分配的账号继续。</p>
        <label>
          账号
          <input name="username" autoComplete="username" required autoFocus />
        </label>
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? '正在登录…' : '登录 →'}
        </button>
        <small>首次启动的管理员账号显示在 API 终端。</small>
      </form>
    </main>
  );
}

function OrderForm({
  close,
  run,
}: {
  close: () => void;
  run: (action: () => Promise<CageResult<unknown, string>>, success: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const ok = await run(
      () =>
        purchaseOrder.create({
          amount: String(data.get('amount')),
          supplierPhone: String(data.get('phone')) || undefined,
          items: [{ sku: String(data.get('sku')), qty: Number(data.get('qty')) }],
        }),
      '采购单已保存为草稿',
    );
    setBusy(false);
    if (ok) close();
  }
  return (
    <div className="modal-backdrop">
      <section role="dialog" aria-modal="true" aria-labelledby="new-order-title" className="modal">
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
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存草稿'}
          </button>
        </form>
      </section>
    </div>
  );
}

type Task = { id: string; businessKey: string; title: string; createdAt: string };

function Workspace({ logout }: { logout: () => void }) {
  const [tab, setTab] = useState<'orders' | 'tasks' | 'stock'>('orders');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const cache = useQueryClient();
  // 列表与统计均来自服务端返回值；不向用户展示写死的演示数字。
  const orders = usePurchaseOrderList({ status, page, pageSize: 10, sort: '-createdAt' });
  const stock = useInventoryList({ pageSize: 100 });
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: async () => {
      const result = await client.get<Task[]>('/api/approval/tasks');
      if (!result.ok) throw new Error(errorMessage(result));
      return result.data;
    },
  });
  async function run(action: () => Promise<CageResult<unknown, string>>, success: string) {
    setBusy(true);
    setMessage('');
    const result = await action();
    setBusy(false);
    setMessage(result.ok ? success : errorMessage(result));
    if (result.ok) await cache.invalidateQueries();
    return result.ok;
  }
  async function exportCsv() {
    const result = await purchaseOrder.export({ status });
    if (!result.ok) {
      setMessage(errorMessage(result));
      return;
    }
    const url = URL.createObjectURL(new Blob(['\uFEFF', result.data], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '采购单.csv';
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="workspace">
      <aside>
        <a className="brand" href="/">
          cage<span>采购工作台</span>
        </a>
        <span className="nav-caption">工作空间</span>
        <nav>
          {(
            [
              ['orders', '01', '采购单'],
              ['tasks', '02', '审批待办'],
              ['stock', '03', '库存台账'],
            ] as const
          ).map(([key, no, label]) => (
            <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>
              <span>{no}</span>
              {label}
              {key === 'tasks' && <b>{tasks.data?.length ?? 0}</b>}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <a href="/admin/">系统管理 ↗</a>
          <div className="user">
            <span className="avatar">{currentUser()?.name?.slice(0, 1) ?? '用'}</span>
            <div>
              {currentUser()?.name}
              <small>已登录</small>
            </div>
          </div>
          <button
            className="logout"
            onClick={async () => {
              await client.logout();
              cache.clear();
              logout();
            }}
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="content">
        <header>
          <span>采购管理 / {tab === 'orders' ? '采购单' : tab === 'tasks' ? '审批待办' : '库存台账'}</span>
          <span className="live-dot">团队工作空间</span>
        </header>
        <div className="page-title">
          <div>
            <span className="eyebrow">
              {tab === 'orders' ? 'PURCHASE ORDERS' : tab === 'tasks' ? 'APPROVAL INBOX' : 'INVENTORY'}
            </span>
            <h1>
              {tab === 'orders' ? '采购单' : tab === 'tasks' ? '审批待办' : '库存台账'}
              <span className="title-dot">.</span>
            </h1>
            <p className="muted">
              {tab === 'orders'
                ? '每一张单据的进展，清晰可见。'
                : tab === 'tasks'
                  ? '处理分配给你的审批任务。'
                  : '查看物料与当前登记数量。'}
            </p>
          </div>
          {tab === 'orders' && can('PurchaseOrder.create') && (
            <button className="primary" onClick={() => setCreating(true)}>
              ＋ 新建采购单
            </button>
          )}
        </div>
        {message && (
          <div role="status" className="notice">
            {message}
            <button onClick={() => setMessage('')} aria-label="关闭提示">
              ×
            </button>
          </div>
        )}
        {tab === 'orders' && (
          <>
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
                  {tasks.data?.length ?? '—'}
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
                        setStatus(value);
                        setPage(1);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {can('PurchaseOrder.export') && <button onClick={exportCsv}>导出 CSV ↗</button>}
              </div>
              {orders.isPending ? (
                <p className="empty">正在读取采购单…</p>
              ) : orders.isError ? (
                <p role="alert" className="error">
                  读取失败：{orders.error.message}
                </p>
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
                              <strong className="mono">PO-{order.id.slice(0, 8).toUpperCase()}</strong>
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
                                        run(
                                          () => purchaseOrder.cancel(order.id, order.version),
                                          '采购单已取消',
                                        )
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
                      <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                        上一页
                      </button>
                      <button disabled={page * 10 >= orders.data.total} onClick={() => setPage(page + 1)}>
                        下一页
                      </button>
                    </div>
                  </footer>
                </>
              )}
            </section>
          </>
        )}
        {tab === 'tasks' && (
          <section className="panel">
            <div className="section-head">
              <h2>待你处理</h2>
              <button onClick={() => void tasks.refetch()}>刷新</button>
            </div>
            {tasks.isError && <p className="error">{tasks.error.message}</p>}
            {tasks.isPending && <p className="empty">正在读取待办…</p>}
            {tasks.data?.map((task) => (
              <div className="task" key={task.id}>
                <div>
                  <h3>{task.title}</h3>
                  <p className="mono muted">PO-{task.businessKey.slice(0, 8).toUpperCase()}</p>
                </div>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => run(() => client.post(`/api/approval/tasks/${task.id}/reject`), '已驳回')}
                  >
                    驳回
                  </button>
                  <button
                    disabled={busy}
                    className="primary"
                    onClick={() =>
                      run(() => client.post(`/api/approval/tasks/${task.id}/approve`), '已通过审批')
                    }
                  >
                    通过审批
                  </button>
                </div>
              </div>
            ))}
            {tasks.data?.length === 0 && (
              <div className="empty">
                <h3>待办已清空</h3>
                <p>新任务分配给你后会显示在这里。</p>
              </div>
            )}
          </section>
        )}
        {tab === 'stock' && (
          <section className="panel">
            <div className="section-head">
              <h2>物料台账</h2>
            </div>
            {can('Inventory.create') && (
              <form
                className="stock-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  if (
                    await run(
                      () =>
                        inventory.create({
                          sku: String(data.get('sku')),
                          available: Number(data.get('available')),
                        }),
                      '物料已登记',
                    )
                  )
                    form.reset();
                }}
              >
                <label>
                  物料编码
                  <input name="sku" required maxLength={64} />
                </label>
                <label>
                  登记数量
                  <input name="available" type="number" min="0" step="1" required />
                </label>
                <button className="primary" disabled={busy}>
                  登记物料
                </button>
              </form>
            )}
            {stock.isError && <p className="error">{stock.error.message}</p>}
            <table>
              <thead>
                <tr>
                  <th>物料编码</th>
                  <th>登记数量</th>
                </tr>
              </thead>
              <tbody>
                {stock.data?.items.map((item) => (
                  <tr key={item.id}>
                    <td className="mono">{item.sku}</td>
                    <td>{item.available}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stock.data?.items.length === 0 && (
              <p className="empty">尚未登记物料。请先登记采购单使用的物料编码。</p>
            )}
          </section>
        )}
        <div className="page-footer">
          CAGE / PROCUREMENT WORKSPACE<span>业务操作均受权限与数据范围约束</span>
        </div>
      </main>
      {creating && <OrderForm close={() => setCreating(false)} run={run} />}
    </div>
  );
}

function App() {
  const [session, setSession] = useState<'loading' | 'guest' | 'ready'>('loading');
  useEffect(() => {
    void loadMe().then((r) => setSession(r.ok ? 'ready' : 'guest'));
  }, []);
  if (session === 'loading') return <div className="loading">正在连接工作台…</div>;
  return session === 'guest' ? (
    <Login onLogin={() => setSession('ready')} />
  ) : (
    <Workspace logout={() => setSession('guest')} />
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
