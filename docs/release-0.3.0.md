# Cage 0.3.0 发布记录

日期：2026-11-07。状态：14 个包已公开发布，latest 全部为 0.3.0；注册表 SHA-512 和完整 README 均与本轮 tarball 一致。两种模板均通过公开 npm 创建、安装、构建和静态检查。

本次将当前工作区实现统一升级为 0.3.0，包含原生 AI、私有文件、运行时本体、诊断工具与多页面模板。已有 0.2.0 不覆盖。14 个包分别携带中文 README，说明用途、安装、公开 API 示例、依赖与运行边界；`@app/*` 和仓库根工程不发布。

发布验收中同时修正了预算统计误计 JSDoc、内嵌 PostgreSQL 退出钩子掩盖失败码、空白模板未覆盖客户端新增错误类型的问题；空白模板的旧契约通过当前生成器更新，历史迁移未改写。AI 截止时间回归改为模型进入后受控触发信号，避免数据库并发负载使测试提前超时而没有覆盖迟到结果场景。

## 包用途与用法

| 包 | 做什么 | 如何接入 |
| --- | --- | --- |
| [cage-kernel](../packages/kernel/README.md) | 聚合、命令、事件、范围、数据库流水线和 worker | domain 声明业务；API/worker 由 HTTP 装配，写入走命令、读取走安全视图 |
| [cage-http](../packages/http/README.md) | 会话、认证、CSRF、路由与服务装配 | API 调用根入口的 `createServer`，worker 从 `@yss123/cage-http/worker` 导入 `startWorker`，共同加载 domain |
| [cage-admin](../packages/admin/README.md) | 组织、角色、授权与管理界面 | domain 导出组织模型，初始化组织后在 `/admin/` 管理并显式授权 |
| [cage-approval](../packages/approval/README.md) | 人工／AI 审批路由与待办 | 从本包使用 `route/step`，结合 kernel 的 `approval` 绑定事件、执行人和领域结论命令 |
| [cage-connectors](../packages/connectors/README.md) | 外部请求、验签、出入站与 fake | domain 声明连接器和映射，密钥由服务端配置，外部结果通过命令落地 |
| [cage-client](../packages/client/README.md) | 浏览器 SDK、权限提示、上传和助理 hooks | Web 使用生成契约，按需使用 `CageClient`、`configureClient` 与 hooks |
| [cage-files](../packages/files/README.md) | 私有存储、上传会话与清理 | kernel 声明文件字段，HTTP 配置存储，client 上传后将 ID 提交给业务命令 |
| [cage-ai](../packages/ai/README.md) | 持久助理循环、工具、记忆和 AI 审批执行 | domain 导出 `ai()`，配置模型、策略和权限，启动同版本 API/worker |
| [cage-ai-protocol](../packages/ai-protocol/README.md) | 浏览器安全的 AI 数据类型与校验 | 前端或服务端按需导入协议类型／schema；不启动模型或数据库 |
| [cage-ontology](../packages/ontology/README.md) | 运行时本体与受控能力发现 | 从注册表生成、查询本体；开发工具通常直接使用 CLI 的图谱和上下文命令 |
| [cage-cli](../packages/cli/README.md) | 创建、生成、迁移、图谱和诊断工具 | 项目安装开发依赖，用 `pnpm exec cage` 执行对应命令 |
| [cage-testkit](../packages/testkit/README.md) | 真实 PostgreSQL 测试环境与测试辅助 | 测试配置接入 global setup，测试环境使用独立临时库 |
| [cage-lint](../packages/lint/README.md) | ESLint 与层级依赖规则 | ESLint flat config 启用插件，或使用 `cage verify` 汇总门禁 |
| [create-cage-app](../packages/create-cage-app/README.md) | npm 创建项目入口 | `pnpm create @yss123/cage-app@0.3.0 my-app --template blank`，采购用 `--template purchase` |

这些链接面向源码仓库；每个包的 README 同时随 tarball 上传到 npm，可独立阅读。新项目自带 `docs/ai` 和 `docs/errors`，无需另外克隆框架。

## 从 0.2.0 升级

1. 备份业务数据库和已有私有文件；将项目使用的全部 `@yss123/cage-*` 依赖统一为 0.3.0，安装后确认 `pnpm exec cage --version`。
2. 运行 `pnpm exec cage sync` 和 `pnpm gen`，审查托管文档、契约及新迁移；业务约定保留在托管区外。不要改写已执行的迁移。
3. 审查并执行 `pnpm migrate`，让框架携带的系统迁移生效，再同时升级 API 和 worker。启动服务不会代办迁移。
4. 使用文件时设置可持久化的私有目录，按[文件指南](ai/files.md)检查配额、授权下载及备份；临时上传完成后仍需命令成功才能绑定。
5. 使用 AI 时按[智能化指南](ai/intelligence.md)显式导出声明、配置模型和部署密钥、授权用户并接入 SDK。空白模板仅有组织模型，采购参考源码不等于 AI 已启用。模型／ERP 的真实外部联调另行验收。
6. 运行 `pnpm exec cage check`、生成一致性和业务回归。已有页面采用新路由模式时，按[路由指南](ai/routing.md)验证深链接、刷新、前进后退、登录回跳、无权限和 404。

本次不自动改写现有应用的业务目录、页面、模型策略或生产角色授权。`cage upgrade` 的历史 codemod 不代替上述配置和迁移审查。

## 本轮验收

以下是本轮实际验收结果；通过、跳过与未执行分别列示。

| 验收项 | 结果 |
| --- | --- |
| 脚本类型检查 | 通过 |
| 构建与文档分发检查 | 通过；两模板共 429 个学习资料文件 |
| 框架测试 | 379 项通过、无跳过（CLI 161、testkit 204、lint 10、admin 4） |
| 采购范例 verify | 类型、依赖、lint、图规则、生成、托管区、预算通过；108 项测试通过、18 项派生用例跳过 |
| 内核预算 | 通过；4384/5000 行、16 个公共原语、unsafe 0 |
| 依赖高危门禁 | `pnpm audit --audit-level high` 通过，无 high/critical；另有 2 项 moderate，见下文 |
| 14 包 tarball、README、入口、资源与内部依赖 | 通过；README 的 8 个独立 TypeScript 示例严格类型检查通过 |
| 两模板仓库外 tarball 安装、构建与静态检查 | 通过；blank/purchase 均完成创建、安装、构建、check、gen/sync 一致性和本体查询；临时项目未连接业务数据库 |
| npm 上传、latest 标签、完整性与 README | 通过；14/14，完整 README 与 tarball 逐份核对一致 |
| 从公开 npm 创建、安装、构建与静态检查 | 通过；blank/purchase 均通过公开创建入口安装 0.3.0、构建、check、gen/sync 一致性、本体上下文及采购关系路径检查；没有 tarball 覆盖或源码链接 |
| 浏览器导航、真实模型／ERP、生产部署、GitHub/Linux CI | 未执行 |

本机产物和验证日志保存在 `.cage/releases/0.3.0`；`manifest.json` 记录本次实际 tarball 的 SHA-512。GitHub 提交、推送和标签不属于本次 npm 发布请求。

同目录保存 `validation.json`、`framework-final.log`、`database-verify.log`、`tarball-smoke.log`、`publish-results.json`、`registry-verification.json` 与 `registry-smoke.json/log`。公开 npm 验证项目保留在 `C:/Users/hasee/AppData/Local/Temp/cage-npm-0.3.0-gQ9zgd`。首次上传后新包索引曾暂时返回 404；同步完成后已重新验证全部版本、README 和公开安装。

范例跳过项为通用派生器未构造成功样例或不适用的权限、状态、范围、幂等及审计用例，不计入通过数；具体名称保存在 `examples/purchase-admin/.cage/test-results.json`。模型和 ERP 使用 fake 验证流程，不代表外部服务联调通过。

本轮依赖审计还报告两项中危：HTTP 的 `@fastify/static → glob`（[GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)），以及 CLI 的 `ts-morph → minimatch`（[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)）。当前未改写这些传递依赖的主版本；本轮高危门禁通过不代表依赖审计零告警。
