# 页面 URL、会话和部署

列表、详情和报表等独立页面使用 React Router 的 URL，app 层组合路由和布局，业务模块提供页面。可分享的筛选与分页进入查询参数；弹窗、草稿与提交状态留在组件中。

## 新增一组页面

在 apps/web/src/modules/note/pages 实现列表与详情，从模块 index.ts 导出；详情使用 useParams 的 id 独立读取服务端对象。app/app.tsx 从模块入口导入，在会话守卫后的 WorkspaceLayout/Outlet 下注册：

```tsx
<Route path="notes" element={<NotesPage />} />
<Route path="notes/:id" element={<NoteDetailPage />} />
```

这是组合片段，沿用当前应用的能力守卫、props 和 404。菜单使用 Link/NavLink，详情可直接在新标签页打开。RequireCapability 改善页面提示，真正的读取与写入仍由服务端授权。

列表使用 useSearchParams 读写 status、page 等条件。条件变化时重置相应页码，并把筛选提交给服务端。组件内的 tab/page 状态适合页内临时交互，不能承担独立页面导航。

[Ant Design 完整列表](../examples/note/notes-table-page.tsx)使用下面的读取逻辑，useSearchParams 来自 react-router-dom，useNoteList 来自生成契约：

<!-- cage:example note-url-query -->
```tsx
const [search, setSearch] = useSearchParams();
const requestedPage = Number(search.get('page'));
const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
const rawStatus = search.get('status');
const status = rawStatus === 'active' || rawStatus === 'archived' ? rawStatus : undefined;
const query = useNoteList({ page, pageSize: 20, status, sort: '-createdAt' });
```

筛选和翻页共用一个 URL 更新函数。筛选变化传 nextPage = 1；点击表格页码时传当前 status：

<!-- cage:example note-url-change -->
```tsx
function changeList(nextPage: number, nextStatus: 'active' | 'archived' | undefined) {
  const next = new URLSearchParams(search);
  next.set('page', String(nextPage));
  if (nextStatus) next.set('status', nextStatus);
  else next.delete('status');
  setSearch(next);
}
```

访问 /notes?status=archived&page=2 应请求归档便笺的第二页；选择“全部”删除 status，而不是只过滤已加载的数据。完整页面还将 query.data.total 交给 Table.pagination，并用 Link 打开详情。

## 会话恢复和登录回跳

应用启动先 loadMe，区分正在恢复、已登录、未登录和网络失败。网络失败显示重试并保留当前地址；UNAUTHENTICATED 才进入登录。

未登录访问详情时，跳到 /login?returnTo=原地址，保留 query/hash。登录后用 replace 返回原页，避免后退循环。共享 navigation.ts 的 loginReturnTo 只接受应用内页面，排除外站、登录循环和服务端保留路径。

例如会话守卫已经确认未登录后，保留完整业务地址再导航。此组件只挂在未登录分支，不用于网络失败：

<!-- cage:check web routing-login-redirect -->
```tsx
export function LoginRedirect() {
  const location = useLocation();
  const returnTo = location.pathname + location.search + location.hash;
  return <Navigate replace to={`/login?returnTo=${encodeURIComponent(returnTo)}`} />;
}
```

登录成功时调用回跳函数。loginReturnTo 从模板 shared/lib/navigation.ts 导入，签名为 (search, fallback)：

<!-- cage:check web routing-login-return -->
```ts
export function useReturnAfterLogin() {
  const location = useLocation();
  const navigate = useNavigate();
  return () => navigate(loginReturnTo(location.search, '/workspace'), { replace: true });
}
```

例如原地址 /notes/某实际ID?tab=comments#latest 应完整恢复；returnTo 指向外站或 /login 时回到 /workspace。

退出、401 或账号切换时取消旧用户请求并清理应用查询缓存。SDK 防止迟到身份响应污染新账号，业务缓存仍由应用处理。403 显示权限提示，范围外详情通常为 404；二者不应触发同一套登录循环。

## 系统管理有独立入口

| 路径 | 所有者与导航 |
| --- | --- |
| /login、/workspace、业务 URL | React Router，应用内使用 Link |
| /admin/ | Cage Admin，使用普通 a 链接完整导航 |
| /api/、/auth/、/hooks/ | HTTP 协议 |
| /assets/ | 构建资源 |

前端不注册覆盖 admin/auth 的路由。审批模块需要链接业务详情时，由 app 映射 businessKey，不跨模块导入另一模块的内部页面。

例如同一个导航中，业务页面使用 Link，系统管理使用完整导航的 a：

<!-- cage:check web routing-navigation-owners -->
```tsx
export function AppLinks() {
  return <nav><Link to="/notes">部门便笺</Link> <a href="/admin/">系统管理</a></nav>;
}
```

cage/no-manual-routes 约束手写后端业务接口，不禁止 React Router。已有老项目的页面迁入 URL 路由需要实际修改前端，单独升级框架依赖不会完成迁移。

## 深链接需要部署支持

开发环境的 Vite 已代理协议和管理入口。生产可由 Cage API 使用 webDir 托管构建目录，标准入口通过 WEB_DIR 配置；也可由 Nginx/CDN 托管 Web 并代理 API。

SPA 回退只用于业务页面。缺失 API、管理脚本和 JS/CSS 保持各自的错误响应，不能返回 index.html。模板 deploy/nginx.conf 和 Dockerfile 提供实际配置参考；开发环境能刷新不证明生产部署也正确。

例如 Nginx server 中先保留服务端与资源入口，业务路径才回退 HTML。下列是模板的相关片段，完整配置还包括分片上传和 AI 流式代理：

```nginx
location ~ ^/(api|auth|hooks|admin)(/|$) {
    proxy_pass http://127.0.0.1:3000;
}
location ^~ /assets/ {
    try_files $uri =404;
}
location / {
    try_files $uri $uri/ /index.html;
}
```

## 浏览器验收

准备真实记录、有 read/范围的账号、缺能力账号与范围外账号，在本次实际部署环境执行：

| 操作 | 预期 |
| --- | --- |
| 新标签页粘贴详情 URL，随后刷新 | 独立读取同一记录 |
| 列表 → 详情 → 其他页，后退和前进 | URL、内容与导航同步 |
| 更改筛选分页，复制或刷新地址 | 恢复同样条件 |
| 未登录打开带 query/hash 的详情 | 登录后回原地址 |
| 会话过期后读取，再用另一账号登录 | 正确回跳，旧账号数据不残留 |
| 缺 read 或范围外直接访问 | 页面有相应提示，API 仍拒绝 |
| 未知业务路径 | 应用 404 与可用返回入口 |
| 打开 /admin/、请求缺失 API/资源 | 各自协议正确，不返回业务 HTML |

检查控制台和实际响应，记录通过、跳过、未执行。构建和静态门禁不替代浏览器操作；模拟接口可以验证导航，真实权限与数据库需另外取得证据。

例如先打开 /notes?status=archived&page=1，再进入一条真实详情；刷新、后退、前进各做一次，URL 与读取对象应一致。另请求不存在的 /api/对象 和 /assets/missing.js，响应不能是便笺页面 HTML。

[客户端与缓存](../reference/client.md) · [返回开发手册](../README.md)
