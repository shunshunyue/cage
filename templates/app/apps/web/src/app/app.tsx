// URL 是页面身份；应用壳只组合路由、会话与模块，不用组件状态模拟多页面导航。
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage } from '../modules/auth';
import { HomePage } from '../modules/workspace';
import { PurchaseOrdersPage, PurchaseOrderDetailPage } from '../modules/purchase';
import { InventoryPage } from '../modules/inventory';
import { ApprovalTasksPage, useApprovalTasks } from '../modules/approval';
import { PageState } from '../shared/ui/page-state';
import { RequireCapability } from '../shared/ui/require-capability';
import { loginReturnTo } from '../shared/lib/navigation';
import { useSession } from './use-session';
import { WorkspaceLayout } from './workspace-layout';

const home = '/workspace';

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

function OrdersRoute() {
  const tasks = useApprovalTasks();
  return <PurchaseOrdersPage pendingTasks={tasks.data?.length} />;
}

function AppRoutes() {
  const { session, restore, onLogin, onLogout } = useSession();
  const location = useLocation();
  if (session === 'loading')
    return (
      <div className="loading" role="status">
        正在连接工作台…
      </div>
    );
  if (session === 'error')
    return (
      <PageState
        title="暂时无法连接工作台"
        description="请检查网络和 API 服务，重试后继续访问当前地址。"
        to={home}
        label="返回工作台"
      >
        <button onClick={restore}>重新连接</button>
      </PageState>
    );
  const login = `/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  return (
    <Routes>
      <Route
        path="/login"
        element={
          session === 'ready' ? (
            <Navigate to={loginReturnTo(location.search, home)} replace />
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
        <Route index element={<Navigate to={home} replace />} />
        <Route path="workspace" element={<HomePage />} />
        <Route
          path="procurement/orders"
          element={
            <RequireCapability capability="PurchaseOrder.read" home={home}>
              <OrdersRoute />
            </RequireCapability>
          }
        />
        <Route
          path="procurement/orders/:id"
          element={
            <RequireCapability capability="PurchaseOrder.read" home={home}>
              <PurchaseOrderDetailPage />
            </RequireCapability>
          }
        />
        <Route
          path="inventory"
          element={
            <RequireCapability capability="Inventory.read" home={home}>
              <InventoryPage />
            </RequireCapability>
          }
        />
        <Route
          path="approvals"
          element={<ApprovalTasksPage orderUrl={(id) => `/procurement/orders/${encodeURIComponent(id)}`} />}
        />
        <Route
          path="*"
          element={
            <PageState
              title="页面不存在"
              description="请检查地址，或从工作台导航进入已有页面。"
              to={home}
              label="返回工作台"
            />
          }
        />
      </Route>
    </Routes>
  );
}
