import { Link, useSearchParams } from 'react-router-dom';
import { useUserList } from '@app/contracts';
import { QueryFailure } from '../../../shared/ui/page-state';

/** 列表来自真实安全接口；分页写入 URL，使刷新、分享和前进后退保留当前页。 */
export function UsersPage() {
  const [search, setSearch] = useSearchParams();
  const requested = Number(search.get('page') ?? 1);
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  const query = useUserList({ page, pageSize: 20, sort: 'name' });
  function go(next: number) {
    const params = new URLSearchParams(search);
    next === 1 ? params.delete('page') : params.set('page', String(next));
    setSearch(params);
  }
  if (query.isPending)
    return (
      <p className="muted" role="status">
        正在读取成员目录…
      </p>
    );
  if (query.isError)
    return (
      <QueryFailure
        error={query.error}
        to="/workspace"
        label="返回工作台"
        retry={() => void query.refetch()}
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">团队与协作</p>
          <h1>成员目录</h1>
          <p className="muted">仅显示你有权查看的成员；账号维护请进入系统管理。</p>
        </div>
      </div>
      <section className="directory-panel">
        <table>
          <thead>
            <tr>
              <th>成员</th>
              <th>账号</th>
              <th>状态</th>
              <th>查看</th>
            </tr>
          </thead>
          <tbody>
            {query.data.items.map((user) => (
              <tr key={user.id}>
                <td>{user.name}</td>
                <td>{user.username}</td>
                <td>{user.status === 'active' ? '使用中' : '已停用'}</td>
                <td>
                  <Link className="record-link" to={`/directory/users/${encodeURIComponent(user.id)}`}>
                    成员详情 ↗
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!query.data.items.length && <p className="directory-empty">当前范围内没有成员。</p>}
        <footer className="directory-pagination">
          <span>
            共 {query.data.total} 人 · 第 {page} 页
          </span>
          <div>
            <button disabled={page === 1} onClick={() => go(page - 1)}>
              上一页
            </button>
            <button disabled={page * 20 >= query.data.total} onClick={() => go(page + 1)}>
              下一页
            </button>
          </div>
        </footer>
      </section>
    </>
  );
}
