/**
 * 采购应用的路由组合层，集中连接认证、工作台、采购、库存和审批模块的公开入口。
 * 会话先恢复，再决定展示页面、跳转登录或保留原地址提示网络故障。
 * 页面身份来自 URL，模块间导航通过 app 注入；前端能力守卫不能代替服务端授权。
 */
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

/**
 * 安装 BrowserRouter 并渲染路由树。部署方需为业务深链接提供 SPA 回退，/api 和 /admin 由各自服务处理。
 */
export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

/**
 * 在组合层读取审批待办数量并传给采购列表，使采购模块不依赖审批页面的内部实现。
 * 待办尚未加载或失败时允许数量缺省，页面显示未知而不伪造零。
 */
function OrdersRoute() {
  const tasks = useApprovalTasks();
  return <PurchaseOrdersPage pendingTasks={tasks.data?.length} />;
}

/**
 * 根据 useSession 的 loading/guest/ready/error 状态组装路由。
 * guest 使用完整路径、查询参数和 hash 构造 returnTo；ready 经 loginReturnTo 校验后回跳。
 * 网络错误保持当前地址以便重试；未知业务地址展示 404 页面，记录读取错误由各页面处理。
 */
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
