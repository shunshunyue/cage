// 库存模块只管理台账页面，登记物料通过生成的 Inventory.create 命令。
import { can, inventory, useInventoryList } from '@app/contracts';
import { useCommand } from '../../../shared/hooks/use-command';
import { Notice } from '../../../shared/ui/notice';
import { PageHeading } from '../../../shared/ui/page-heading';
import { QueryFailure } from '../../../shared/ui/page-state';
import { AssistantPage } from '../../../shared/ui/assistant-scope';

export function InventoryPage() {
  const stock = useInventoryList({ pageSize: 100 });
  const { run, busy, message, clearMessage } = useCommand();
  if (stock.isPending)
    return (
      <p className="empty" role="status">
        正在读取库存台账…
      </p>
    );
  // 页面已打开后权限仍可能变化，必须处理安全接口的拒绝，不能把失败展示成空台账。
  if (stock.isError)
    return (
      <QueryFailure
        error={stock.error}
        to="/workspace"
        label="返回工作台"
        retry={() => void stock.refetch()}
      />
    );
  return (
    <>
      <AssistantPage context={{ page: { id: 'inventory', title: '库存台账', kind: 'list', route: '/inventory' },
        view: { aggregate: 'Inventory', input: { pageSize: 100 }, visibleIds: stock.data.items.map(item => item.id) },
      }} suggestions={['汇总当前可见的物料库存', '查询库存时有哪些权限限制？']} />
      <PageHeading eyebrow="INVENTORY" title="库存台账" description="查看物料与当前登记数量。" />
      {message && <Notice onClose={clearMessage}>{message}</Notice>}
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
    </>
  );
}
