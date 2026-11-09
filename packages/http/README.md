# @yss123/cage-http

Cage 的 HTTP 与进程装配层。根据 domain 注册表生成业务接口，组合 Cookie 会话、密码/OIDC 认证、CSRF、限流、日志脱敏、系统管理、文件和可选 AI/审批接口。应用只需薄启动入口，业务写操作继续由内核命令执行。

## 安装

需要 Node.js 24+、已初始化并迁移的 PostgreSQL；框架包保持同版本。在 API 包安装：

```powershell
pnpm add @yss123/cage-http
```

首次使用可执行 `pnpm create @yss123/cage-app my-app --template blank`，模板已配置 API 与独立 worker。

## 启动 API 和 worker

以下文件放在脚手架的 API 包，`@app/domain` 是本应用导出的声明。进程须从应用根目录加载本地 `.env`，或由部署系统注入环境变量。

```ts
/** API 入口：按领域声明装配接口，启动时不迁移数据库或创建管理员。 */
import { createServer } from '@yss123/cage-http';
import * as domain from '@app/domain';

const server = createServer({ domain });
await server.listen({ port: 3000, host: '127.0.0.1' });
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
```

单独运行 worker 入口，消费 outbox、审批启动、连接器出站和定时任务；API 与 worker 使用同一版本、同一 domain 和数据库：

```ts
/** 后台入口：框架管理调度、重试与连接，退出时等待在途工作收尾。 */
import { startWorker } from '@yss123/cage-http/worker';
import * as domain from '@app/domain';

const worker = await startWorker({ domain });
process.once('SIGINT', () => void worker.stop());
process.once('SIGTERM', () => void worker.stop());
```

标准模板使用 `pnpm dev` 同时启动开发进程。手动部署需配置 `CAGE_APP_DATABASE_URL` 和 `CAGE_READ_DATABASE_URL`，指向同一已有数据库的不同账号；生产环境还须注入至少 32 字节的 `CAGE_COOKIE_SECRET`。真实值仅存在部署配置中。

## 常用配置与生命周期

| 入口/选项 | 用途 |
| --- | --- |
| `createServer({ domain })` | 自动并入组织模型与声明路由，默认开启 `/admin/` |
| `server.ready()` / `server.app` | 初始化后用 Fastify `inject` 做 HTTP 集成测试，不必监听端口 |
| `server.listen()` / `server.close()` | 开始监听及释放 HTTP、扩展、授权监听和连接池 |
| `server.health()`、`/readyz` | 检查数据库和授权监听是否就绪；`/healthz` 仅表示存活 |
| `webDir` | 托管已构建业务 SPA；本地开发可由 Vite 提供 Web |
| `trustProxy` | 配置实际可信代理，默认 `false` |
| `files` | 私有存储目录、适配器与上传限额 |
| `adminLabels` | 覆盖系统管理中的中文展示名，不改变真实能力标识 |
| `routeTable`、`buildOpenApi` | 基于注册表获取路由与接口描述 |

数据库准备顺序是 `cage init` → 审查并执行 `cage migrate` → 显式 `cage bootstrap` → 启动服务；具体初始化参数以模板 README 为准。`createServer` 不承担这些管理操作，`bootstrap: true` 会被拒绝。

不要在 API 入口为普通业务新增手写写路由；修改 domain 并生成契约即可。浏览器使用 `@yss123/cage-client` 和 `@app/contracts`，不导入本包。前端按钮权限、审批选人和连接器回调都不能跳过内核最终授权。

## 文档

- [架构、数据库与权限](https://github.com/shunshunyue/cage/blob/main/docs/ai/architecture.md)
- [路由与 SPA 部署](https://github.com/shunshunyue/cage/blob/main/docs/ai/routing.md)
- [私有文件](https://github.com/shunshunyue/cage/blob/main/docs/ai/files.md)
- [原生 AI 接入](https://github.com/shunshunyue/cage/blob/main/docs/ai/intelligence.md)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
