/**
 * 已登录空白应用的公共外壳，装配品牌、导航、账号信息、退出登录和子页面 Outlet。
 * 成员目录和系统管理入口依据 User.read 能力显示；该显示判断不代表拥有全部管理操作。
 */
// 应用壳负责导航和账号状态；具体页面通过业务模块的公开入口组合。
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { client, currentUser, useCan } from '@app/contracts';
import { errorMessages } from '../shared/lib/error-message';
import { Brand } from '../shared/ui/brand';

/**
 * 从路由计算当前位置标题，读取当前账号与能力，承载各业务模块页面。
 * onLogout 由 app 提供，退出请求成功并清空缓存后调用；失败在当前页面显示原因。
 */
export function WorkspaceLayout({ onLogout }: { onLogout: () => void }) {
  // 能力只决定界面入口是否展示；系统管理接口还会再次校验授权。
  const canManage = useCan('User.read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const user = currentUser();
  const cache = useQueryClient();
  const location = useLocation();
  const page = location.pathname.startsWith('/directory/users/')
    ? '成员详情'
    : location.pathname === '/directory/users'
      ? '成员目录'
      : location.pathname === '/workspace'
        ? '工作台'
        : '页面';

  /**
   * 等待 SDK 结束服务端会话，成功才清除查询缓存并通知 app。
   * 失败不伪造已退出状态；按钮在结果返回前保持忙碌。
   */
  async function logout() {
    setBusy(true);
    const result = await client.logout();
    setBusy(false);
    if (result.ok) {
      cache.clear();
      onLogout();
    } else setError(errorMessages[result.code]);
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <span className="sidebar-label">工作空间</span>
        <NavLink className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} to="/workspace">
          <span aria-hidden="true">◫</span>工作台<span className="nav-arrow">↗</span>
        </NavLink>
        {canManage && (
          <NavLink className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} to="/directory/users">
            <span aria-hidden="true">♧</span>成员目录<span className="nav-arrow">↗</span>
          </NavLink>
        )}
        {canManage && (
          <a className="nav-item" href="/admin/">
            <span aria-hidden="true">⚙</span>系统管理<span className="nav-arrow">↗</span>
          </a>
        )}
        <div className="sidebar-note">
          <span className="status-dot" />
          从一个好起点出发
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <span>
            工作空间<span className="breadcrumb-divider">/</span>
            <strong>{page}</strong>
          </span>
          <div className="account">
            <span className="avatar">{user?.name.slice(0, 1)}</span>
            <span>{user?.name}</span>
            <button className="text-button" onClick={logout} disabled={busy}>
              {busy ? '正在退出…' : '退出登录'}
            </button>
          </div>
        </header>
        <main className="workspace-content">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
