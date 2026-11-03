// 页面身份交给 React Router；会话恢复、布局和业务模块在应用层组合。
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage } from '../modules/auth';
import { HomePage } from '../modules/workspace';
import { UsersPage, UserDetailPage } from '../modules/directory';
import { Brand } from '../shared/ui/brand';
import { PageState } from '../shared/ui/page-state';
import { RequireCapability } from '../shared/ui/require-capability';
import { loginReturnTo } from '../shared/lib/navigation';
import { useSession } from './use-session';
import { WorkspaceLayout } from './workspace-layout';

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

function AppRoutes() {
  const { session, restore, onLogin, onLogout } = useSession();
  const location = useLocation();

  if (session === 'loading')
    return (
      <main className="session-state" role="status">
        <Brand />
        <p>正在打开工作空间…</p>
      </main>
    );
  if (session === 'error')
    return (
      <main className="session-state">
        <Brand />
        <h1>暂时无法连接工作台</h1>
        <p role="alert">请检查网络和 API 服务，然后重新尝试。</p>
        <button className="primary" onClick={restore}>
          重新连接<span aria-hidden="true">↗</span>
        </button>
      </main>
    );
  const login = `/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  return (
    <Routes>
      <Route
        path="/login"
        element={
          session === 'ready' ? (
            <Navigate to={loginReturnTo(location.search, '/workspace')} replace />
          ) : (
            <LoginPage onLogin={onLogin} />
          )
        }
      />
      <Route
        element={
          session === 'ready' ? <WorkspaceLayout onLogout={onLogout} /> : <Navigate to={login} replace />
        }
      >
        <Route index element={<Navigate to="/workspace" replace />} />
        <Route path="workspace" element={<HomePage />} />
        <Route
          path="directory/users"
          element={
            <RequireCapability capability="User.read" home="/workspace">
              <UsersPage />
            </RequireCapability>
          }
        />
        <Route
          path="directory/users/:id"
          element={
            <RequireCapability capability="User.read" home="/workspace">
              <UserDetailPage />
            </RequireCapability>
          }
        />
        <Route
          path="*"
          element={
            <PageState
              title="页面不存在"
              description="请检查地址，或从工作空间导航进入已有页面。"
              to="/workspace"
              label="返回工作台"
            />
          }
        />
      </Route>
    </Routes>
  );
}
