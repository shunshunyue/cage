# @yss123/cage-http

将同一 domain 装配成 HTTP 服务：认证、Cookie 会话、CSRF、自动业务路由、OpenAPI、系统管理、文件及可选审批/AI 接口。业务授权和写入继续交给内核。

## 启动

在 API 包安装 pnpm add @yss123/cage-http，使用 Node.js 24+、同版本框架及已迁移 PostgreSQL。以下位于已配置环境变量的应用 API 入口：

```ts
import { createServer } from '@yss123/cage-http';
import * as domain from '@app/domain';

/** 装配当前业务；listen 不迁移数据库或重置初始账号。 */
const server = createServer({ domain });
await server.listen({ host: '127.0.0.1', port: 3000 });
process.once('SIGTERM', () => void server.close());
```

worker 使用 @yss123/cage-http/worker 的 startWorker({ domain })，消费 outbox、审批和连接器等。API 与 worker 使用相同版本、domain 和数据库；生产入口应完整处理终止信号和 close。

## 协议和生命周期

注册表只为允许 user 的命令生成普通写接口，读取使用安全视图；内部流程和回调从受控入口进入命令。服务可托管 Web 构建目录，SPA 回退需与 API、Admin 和静态资源区分。

init、migrate、bootstrap 由部署明确执行。createServer 不安装 PostgreSQL、不创建业务数据库、不自动初始化组织。文件存储与可选运行时按实际声明和配置启用。

[启动指南](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/start.md) · [路由与部署](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/routing.md) · [执行模型](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/architecture.md)
