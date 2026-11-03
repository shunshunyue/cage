// 应用壳组合模块公开入口，只持有导航和会话；表单、筛选、命令留在各业务模块。
import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { client, currentUser } from '@app/contracts';
import { useApprovalTasks } from '../modules/approval';
import { errorMessage } from '../shared/lib/error-message';

export function WorkspaceLayout({ onLogout }: { onLogout: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  const page = location.pathname.startsWith('/procurement/orders/')
    ? '采购单详情'
    : location.pathname === '/procurement/orders'
      ? '采购单'
      : location.pathname === '/approvals'
        ? '审批待办'
        : location.pathname === '/inventory'
          ? '库存台账'
          : location.pathname === '/workspace'
            ? '工作台'
            : '页面';
  const tasks = useApprovalTasks();
  const cache = useQueryClient();
  return (
    <div className="workspace">
      <aside>
        <Link className="brand" to="/workspace">
          cage<span>采购工作台</span>
        </Link>
        <span className="nav-caption">工作空间</span>
        <nav>
          {(
            [
              ['/workspace', '00', '工作台'],
              ['/procurement/orders', '01', '采购单'],
              ['/approvals', '02', '审批待办'],
              ['/inventory', '03', '库存台账'],
            ] as const
          ).map(([key, no, label]) => (
            <NavLink key={key} to={key} className={({ isActive }) => (isActive ? 'selected' : '')}>
              <span>{no}</span>
              {label}
              {key === '/approvals' && <b>{tasks.data?.length ?? 0}</b>}
            </NavLink>
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
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await client.logout();
              setBusy(false);
              if (result.ok) {
                cache.clear();
                onLogout();
              } else setError(errorMessage(result));
            }}
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="content">
        <header>
          <span>采购管理 / {page}</span>
          <span className="live-dot">团队工作空间</span>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Outlet />
        <div className="page-footer">
          CAGE / PROCUREMENT WORKSPACE<span>业务操作均受权限与数据范围约束</span>
        </div>
      </main>
    </div>
  );
}
