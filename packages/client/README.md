# @yss123/cage-client

Cage 浏览器 SDK：统一 Cookie 会话、CSRF、请求取消、超时、错误结果与幂等键；提供能力判断、React 查询/命令 hooks、可恢复文件上传和 AI 流式会话。生成的 `@app/contracts` 基于本包提供每个业务对象的类型化接口。

## 安装

```powershell
pnpm add @yss123/cage-client react @tanstack/react-query zod
```

开发工具链需要 Node.js 24+。本包在浏览器运行，当前入口包含 React hooks，peer 依赖为 React 18+、TanStack Query 5、Zod 4。业务 Web 只依赖客户端、协议与生成契约，不导入 domain、数据库或 AI 服务端运行时。

## 恢复会话并调用业务

在脚手架应用中使用共享 `client`，避免给不同业务模块各建独立的会话状态。`baseUrl` 是站点前缀，不要再附加 `/api`；SDK 方法已有各自的完整路径。

```ts
/** 页面启动时恢复已有 Cookie 会话；401 时由应用进入登录流程。 */
import { configureClient, loadMe, can } from '@yss123/cage-client';

configureClient({ baseUrl: '', timeoutMs: 30_000 });
const session = await loadMe();
if (!session.ok) {
  console.error(session.code, session.requestId);
} else {
  // 仅用于界面可见性；服务端仍按当前能力和数据范围检查每次请求。
  console.log(can('Note.create'));
}
```

下例要求应用已声明 `Note.create` 并运行 `pnpm gen`；`note` 是生成契约，不是本包内置业务：

```ts
import { note } from '@app/contracts';

const result = await note.create({ title: '本周计划' });
if (result.ok) {
  console.log(result.data.id);
} else {
  // 业务失败和网络失败都需展示；不能未检查 ok 就把请求当成已保存。
  console.error(result.code, result.domainCode, result.requestId);
}
```

登录使用 `client.login(username, password)`，它会加载 `/api/me`；退出使用 `client.logout()`。从本包导入 `client`，输入来自应用登录表单，不在源码中保存凭据。退出、401 和账号切换会取消本实例的在途请求与订阅；应用还须清空自己的页面及 TanStack Query 缓存。

## 接口选择

| 入口 | 作用 |
| --- | --- |
| `CageClient`、`client`、`configureClient` | 独立实例、默认共享实例与网络配置 |
| `CageResult`、`CageQueryError`、`CageCommandError` | 可区分成功/失败的结果及 hooks 错误 |
| `loadMe`、`currentUser`、`can`、`useCan` | 当前会话和界面能力判断 |
| `useCageQuery`、`useCageList`、`useCageCommand` | 基于 TanStack Query 的读取、分页及命令；组件树需 `QueryClientProvider` |
| `client.upload`、`FileUploadTask`、`useFileUpload` | 分片上传、暂停/续传与进度订阅；完成后再把文件 ID 交给业务命令 |
| `client.ai`、`useAssistant`、`useAiPageContext` | AI 会话、增量文字、工具进度、确认交互及页面语义快照 |
| `useTransfer` | 观察导入/导出任务状态；接受请求不等于任务完成 |

写请求默认每次生成新幂等键；同一业务意图的跨调用重试需通过 `RequestOptions.idempotencyKey` 复用键。取消或网络超时不证明服务端没有提交，页面应重新核对结果。前端 `can()` 只控制交互提示，不是授权凭据。

AI hooks 提供状态层，聊天布局与 Markdown 渲染由应用编写；需在后端启用 `ai()`、运行 worker 并授予 `Sys.ai.use`。文件续传在刷新后需要用户重新选择原文件，SDK 校验内容后才恢复。

## 文档

- [业务前端与路由](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/routing.md)
- [AI 会话、页面上下文与流式 SDK](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/intelligence.md)
- [文件上传](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/files.md)
- [导入导出](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/transfers.md)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
