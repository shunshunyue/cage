# 业务前端路由与浏览器验收

[返回学习入口](../README.md) · [工程目录](../reference/project-structure.md) · [开发步骤](../getting-started/workflow.md)

多页面业务默认使用 React Router 的 BrowserRouter。列表、详情、报表等可独立访问的页面必须有 URL；在 app 中统一组合路由和工作台布局，页面从模块 index.ts 导出。useState 用于弹窗、未提交表单和按钮忙碌状态。筛选、分页和需要分享的选项使用 useSearchParams。

本页对应后续开发版本的模板改进；已发布的 0.2.0 项目需要按本页迁入路由实现，不能只升级依赖就认为旧页面已完成改造。框架包无需维护客户的页面地址。

## 模板中的可运行示例

| 页面 | 空白模板 | 采购模板 |
| --- | --- | --- |
| 登录 | `/login` | `/login` |
| 工作台 | `/workspace` | `/workspace` |
| 列表 | `/directory/users?page=2` | `/procurement/orders?status=draft&page=2` |
| 详情 | `/directory/users/:id` | `/procurement/orders/:id` |
| 其他业务 | 按实际需求新增 | `/inventory`、`/approvals` |
| 404 | 未匹配页面显示“页面不存在” | 同左 |

`:id` 替换成真实记录 ID。空白模板的成员目录读取已有 User 组织模型，不注册额外业务、演示表或虚假数据；列表与详情均需要 User.read，数据范围由安全接口落实。采购待办的 businessKey 由 app 映射成采购详情链接，审批模块不直接导入采购模块。

在应用根目录运行 pnpm dev 后访问终端打印的 Web 地址。先在系统管理配置真实账号与权限，再从列表复制某条记录的详情 URL，用于刷新和新标签页测试。

## 新增一项业务页面

1. 在 `apps/web/src/modules/<业务>/pages` 编写列表、详情和表单，从模块 index.ts 导出。详情用 useParams 读取 ID，再用生成的 use对象(id) 获取记录；不要求先打开列表，也不从组件状态或上一页传来的对象直接认定记录存在。
2. 在 `apps/web/src/app/app.tsx` 注册列表与详情 Route。放在已有会话守卫和 WorkspaceLayout 之下，使页面通过 Outlet 渲染。新增实际页面时扩展路由表；不要再添加 tab/page useState 来选择整页。
3. 导航使用 Link / NavLink；完整页面地址可收藏、复制或新标签页打开。列表筛选和分页通过 useSearchParams 更新，刷新和前进后退恢复相应查询。
4. 需要 read 能力的页面用共享 RequireCapability 提供直接访问时的提示；服务端返回 FORBIDDEN 时显示权限提示，NOT_FOUND 显示“记录不存在，或不在当前可访问范围”。401 由会话回调进入登录。不要把 403 当成登录失效，也不要通过放宽读权限解决页面导航问题。
5. 用下面的浏览器配方验收，并报告通过、跳过与未执行。构建和 cage verify 通过，只证明其各自检查范围，不能据此宣称路由体验正确。

```tsx
// app 中的组合片段：页面通过所属模块的 index.ts 导出。
<Route element={<WorkspaceLayout onLogout={onLogout} />}>
  <Route path="procurement/orders" element={<PurchaseOrdersPage />} />
  <Route path="procurement/orders/:id" element={<PurchaseOrderDetailPage />} />
</Route>
```

片段只展示路由与布局关系。实际代码参考本模板 app.tsx，保留会话守卫、页面 props 和能力提示。`cage/no-manual-routes` 限制手写后端业务 HTTP 路由，不禁止 React Router；前端导航不会生成能力或授予数据访问权。

## 登录后返回原地址

应用启动先 loadMe 恢复会话。未登录访问详情时，守卫使用 replace 导航到 `/login?returnTo=编码后的原路径`，包含 query 和 hash。登录完成再次 replace 回原页面，避免浏览器后退反复落入登录页。

`shared/lib/navigation.ts` 的 loginReturnTo 只接受应用内页面，排除外站、登录循环及 API/admin 等服务端入口；不要直接把用户提供的任意 returnTo 交给 location.href。网络错误显示重试界面并保留地址，只有 UNAUTHENTICATED 才要求重新登录。运行中会话过期同样保存当前 URL，并清除上一账号的查询缓存。

前端路由守卫只改善导航与提示。请求仍由 Cage HTTP 和内核检查会话、能力、租户、数据范围与掩码；直接请求接口必须得到相同约束。

## 与系统管理及部署共存

| 路径 | 所有者 |
| --- | --- |
| `/login`、`/workspace`、客户业务页面 | React Router |
| `/admin`、`/admin/` 及其脚本/样式 | Cage 系统管理 |
| `/api/`、`/auth/`、`/hooks/` | Cage HTTP 接口 |
| `/assets/` | Vite 构建资源 |

进入 `/admin/` 使用普通 `<a href="/admin/">`，让浏览器请求独立管理入口；应用内部页面使用 Link。不要在 React 中注册覆盖 /admin 或 /auth 的页面。Vite 配置已代理 API、认证与管理请求，开发环境支持业务深链接刷新。

生产可选两种部署方式：

- **Cage 托管 Web**：API 启动时提供 webDir，标准入口读取 WEB_DIR；将其设置为 apps/web/dist 的绝对路径。模板 Dockerfile 已复制构建产物并设置 WEB_DIR=/app/web。浏览器 GET/HEAD 页面请求可回退到 index.html，React 决定详情或 404；API、管理和丢失资源返回各自错误，不应变成业务首页。
- **Nginx 托管 Web**：参考项目 `deploy/nginx.conf`，将 root 指向真实 dist，将 API/admin/auth/hooks 代理到 Cage；业务页面使用 try_files 回退到 index.html，/assets/ 缺失时直接 404。示例按 Nginx 与 API 在同一主机、API 端口 3000 编写；按部署拓扑修改上游。仅复制 dist 到没有 SPA 回退的静态服务器会导致详情刷新 404。

上线前用实际反向代理地址验收深链接。Vite 开发环境成功，不代表 Nginx、CDN 或生产容器已配置正确。

## 浏览器验收配方

准备一条有权读取的真实记录和两个测试账号：有 read 能力及范围的账号、没有该能力的账号。测试账号和记录在独立验收环境准备，不修改生产角色。

| 操作 | 预期结果 |
| --- | --- |
| 复制列表中某条详情 URL，在新标签页粘贴 | 直接加载对应记录，无需先访问列表 |
| 在详情页刷新 | URL 和记录保持一致 |
| 列表 → 详情 → 另一页面，再点浏览器后退、前进 | 地址、页面内容与导航高亮同步变化 |
| 改变列表筛选/分页，复制地址或刷新 | 条件与列表恢复，不返回工作台或第一页 |
| 未登录打开带 query/hash 的详情 URL | 进入登录；成功后回到原 URL，保留 query/hash |
| 在业务页使测试会话过期，再触发读取 | 进入登录；重新登录后回到原页面，旧账号缓存不残留 |
| 无 read 能力账号直接访问有效详情地址 | 显示权限提示，直接请求 API 仍为 403 |
| 有 read 能力但记录位于范围外 | 显示记录不可用，直接请求 API 为 404，不泄露记录是否存在 |
| 访问不存在的业务路径 | 显示应用 404，并有返回工作台入口 |
| 访问 /admin/，以及缺失的 API/JS/CSS | 管理入口独立可用；缺失接口或资源不返回业务 index.html |
| 在实际部署地址重复深链接和刷新步骤 | 正常加载，浏览器控制台无脚本 MIME 错误 |

验收记录写明模板、地址、操作和结果。模拟 API 的浏览器检查可以证明导航行为；真实权限、范围和数据库链路需要相应集成验收，二者分别报告。
