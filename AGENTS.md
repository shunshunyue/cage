# Cage 框架维护指南（给 AI 与开发者）

本仓库实现 Cage 框架本身，使用 TypeScript、pnpm workspace、Node.js 24 和 PostgreSQL。先区分任务是在维护框架还是编写业务：业务范例位于 `examples/purchase-admin`，采购模板位于 `templates/app`，空白模板位于 `templates/blank`。进入子目录后还要遵守该目录的 AGENTS.md。

## 先读什么

1. [AI 学习入口](docs/ai/README.md)：阅读顺序、按任务选文件、当前能力边界。
2. [架构与执行模型](docs/ai/architecture.md)：理解聚合、流水线、权限、数据库与 worker。
3. [原语与最小业务](docs/ai/primitives.md)：按实际 API 编写字段、命令、事件与查询。
4. [标准采购范例导读](docs/ai/purchase-example.md)：审批、资源配对、ERP、前端的完整链路。
5. [开发步骤](docs/ai/workflow.md)与[错误码册](docs/errors/README.md)：修改、验证、排错。
6. [对象关系](docs/ai/relations.md)：fields 中的一对多、多对多，自动中间表与关联分页。
7. [工程目录与代码组织](docs/ai/project-structure.md)：脚手架的模块归属、公开入口、命名与依赖门禁。
8. [本体查询与 AI 上下文](docs/ai/ontology-context.md)：开发前按中文需求查节点、关系与源码，判断候选证据和覆盖边界。
9. [业务前端路由与浏览器验收](docs/ai/routing.md)：多页面 URL、登录回跳、系统管理共存、SPA 部署与实际浏览器验收。
10. [能力发现与状态诊断](docs/ai/diagnostics.md)：公开签名、注册与构建状态、进程证据、执行时间线、授权解释与命名基线。
11. [原生智能助理与 AI 审批](docs/ai/intelligence.md)：智能审批三态、领域助理、Admin 模型与性格配置、随页上下文、流式 SDK 和上下文预算。遇到相关需求先核对现有框架能力及应用启用状态。
12. [详细中文注释规范](docs/ai/commenting.md)：所有源码必须遵守的文件说明、API 文档、关键流程与业务边界注释；新增、修改和交付时均检查。

这些文档描述当前实现；技术方案中的规划不能直接当作已存在的 API。API 有疑问时核对相应包的 `src/index.ts` 和声明实现，不发明配置项、命令或导出。

## 框架如何工作

业务先声明 `aggregate → command → event → reaction / approval / connector`。声明是模块顶层的 `export const`，由业务入口统一导出。框架从同一份声明构建注册表、能力目录、HTTP 路由、本体图、前端契约和迁移草稿。

- **聚合**把同一个业务对象的字段、状态、范围字段和不变量放在一起。它通常对应一张主表，也负责定义可执行的命令，不能只按“表”理解。
- **命令**是唯一业务写入口。handler 描述业务变化；权限、状态、版本、事务、审计、outbox 由内核执行。
- **读侧**通过 `safe.*` 安全视图和只读账号查询，落实数据范围与敏感字段掩码。
- **事件与反应**连接业务行为。`tx: 'same'` 与主命令共同提交；默认 outbox 由 worker 异步执行。标签 `acquires/releases` 仅用于静态资源配对，实际动作仍由命令完成。
- **审批与第三方**最终回到领域命令。流程选人不等于授予能力，连接器不允许绕过命令直接写表。
- **原生 AI**由 `ai()` 导出启用，AI 审批使用现有 `step` 的 `kind: 'ai'` 类型。框架负责执行循环、工具、会话与偏好记忆、流式接口和 SDK；应用负责策略、授权、页面快照与界面。给业务项目提供能力入口时修改 CLI 的 `sync.ts` 托管区、`capabilities.ts` 检索提示和 `docs/ai`，再同步模板；框架支持、应用启用、实际验证要分别说明。

## 到哪里修改

| 任务 | 位置 | 责任边界 |
| --- | --- | --- |
| 原语、写流水线、读侧、DDL、迁移、worker、通用数据传输 | `packages/kernel/src` | 业务无关；不能出现采购、库存等业务分支 |
| HTTP、认证、CSRF、OpenAPI | `packages/http/src` | 根据注册表生成接口，调用内核 |
| 文件上传、分片续传、私有存储 | `packages/files/src` | 字节 IO、会话和清理；字段原语及事务内绑定仍在 kernel |
| 用户、部门、角色、系统管理页面 | `packages/admin/src` | 组织模型、防提权、运营管理 |
| 审批路由、适配器、待办 | `packages/approval/src` | 决定步骤与执行人，结论通过命令落实 |
| 连接器声明、验签、出站与 fake | `packages/connectors/src` | 管理外部 IO 边界 |
| 客户端与 hooks | `packages/client/src` | 网络协议、类型化结果、界面能力判断 |
| 原生 AI 运行时与本体 | `packages/ai/src`、`packages/ontology/src`、`packages/ai-protocol/src` | 持久循环、工具、记忆、审查执行；协议可供前端使用，运行时不得进入浏览器 |
| 抽取、图规则、生成器、门禁、脚手架 | `packages/cli/src` | 静态分析与开发工具，不复制运行时业务逻辑 |
| 测试环境、lint 规则 | `packages/testkit`、`packages/lint` | 真实 PostgreSQL 验证及依赖边界 |
| 标准业务实现 | `examples/purchase-admin` | 演示如何消费框架，遵守其应用 AGENTS.md |
| 采购分发模板 | `templates/app` | 从范例同步；不要在这里独立实现第二套采购功能 |
| 空白分发模板 | `templates/blank` | 单独维护空白领域与页面；共享基础配置、教材及参考源码由同步脚本更新 |
| AI 指南、错误码源资料 | `docs/ai`、`scripts/error-catalog.ts` | 指南手写；逐码页面由脚本生成 |

## 修改约定

- 智能体并发总数最多为 2：主智能体之外最多启用 1 个子智能体。需要更多分工时顺序执行，不能同时启动多个子智能体。
- 所有手写代码必须有详细中文注释，具体遵守 [详细中文注释规范](docs/ai/commenting.md)。文件头写明职责、调用关系和边界；导出函数、类、组件、hooks、类型和业务声明用 JSDoc 说明用途、输入输出、流程、失败及副作用；复杂内部函数、关键分支和类型字段补充就地说明。
- 注释必须同时解释“做什么、为什么、如何完成、有哪些边界”，不能只写一句标题、只说为什么，或以“代码自解释”为由省略。金额/数量的单位、空值语义、状态条件、权限与范围、事务/并发/幂等/重试、缓存与异步清理等按实际实现写清；没有实现的保证不能写成已经支持。
- 新增代码同步写注释，修改代码同步核对并更新相关注释；交付前逐文件检查，补足本次触及职责的上下文。仅补注释的任务保持逻辑、接口、配置值和运行文案不变；生成物的注释从生成器维护，已发布迁移不改写。不得用机械逐行翻译、凑字数或重复模板替代具体解释。
- 避免没有业务价值的防御分支和静默兜底。
- 新增和维护脚本使用 TypeScript（`.ts`），不新增 `.mjs`。Node.js 24 可直接运行本仓库使用的可擦除类型语法。
- 内核保持业务无关。需要修改内核时说明必要性，用有意义的回归用例证明行为，发布前由架构负责人评审。
- 业务写入走命令，读侧走安全视图，外呼走连接器。前端只依赖契约与客户端，不导入 domain、数据库或内核。
- handler 的读依赖写进 `reads`；job 的读和命令调用写进 `reads/calls`；所有声明从 domain 入口导出。
- 范例及模板按业务模块组织：Web 使用 app/modules/shared，domain 使用 modules/workflows/integrations/shared；src 根入口只负责组合。contracts 目录由生成器按聚合生成，保留根公共 API。两模板启用 structure: modular，不关闭目录门禁来适应平铺代码。
- 多页面业务使用 React Router，列表、详情等页面有独立 URL，筛选/分页进入查询参数，组件状态用于页面内临时交互。路由由 app 组合，页面通过模块入口进入 Outlet；变更导航后实际检查深链接、刷新、前进后退、登录回跳、无权限和 404。静态门禁不能代替浏览器验收。
- 新增能力不自动授给生产角色。前端 `can()` 只控制显示，服务端负责真正授权。
- 不手改契约等生成物；修改 domain 后运行 `pnpm --filter @app/purchase-admin gen`，审查生成差异。
- 已执行或已发布的迁移不可改写。新结构通过新迁移表达，生成的迁移先作为草稿审查。
- `.env`、Cookie 密钥、数据库密码、初始化凭证不得进入源码或文档；诊断连接时只输出主机、端口、库名和错误码。
- 不为普通业务新建连接池或管理 Docker。项目 `.env` 配置已有 PostgreSQL；`init` 准备账号，`migrate` 更新表，`dev` 启动进程。

## 工作顺序与验证

先读相关代码和已有测试，选定最小修改位置；涉及领域含义变化时，修改前保存本体图基线。再改声明与实现，生成契约和迁移草稿，最后运行与改动相关的检查。文档或可逆的小改动不需要反复跑全套数据库回归。

| 执行目录 | 命令 | 用途 |
| --- | --- | --- |
| 仓库根目录 | `pnpm install`、`pnpm build` | 安装并构建框架、范例 API 和 Web |
| 仓库根目录 | `pnpm test` | CLI、ESLint、PostgreSQL 内核和 HTTP 回归 |
| 仓库根目录 | `pnpm example:verify` | 范例类型、依赖、lint、图规则、生成一致性和数据库测试 |
| 仓库根目录 | `node packages/cli/bin/cage.js budget` | 内核体积、公共词汇和 unsafe 预算 |
| 范例目录 | `pnpm exec cage check`、`pnpm gen` | 检查声明、重新生成 |
| 范例目录 | `pnpm exec cage graph` | 在浏览器检查业务图谱与中文说明 |
| 仓库根目录 | `pnpm docs:check` | 检查学习资料链接和脚手架分发内容 |
| 仓库根目录 | `pnpm typecheck:scripts` | 检查维护脚本的 TypeScript 类型 |

交付时分别报告**通过、跳过、未执行**，不能把跳过当作通过。出现错误先看完整诊断中的 `code / at / reason / fix`，再查对应错误码；不要用删除约束、放宽权限、禁用 lint 或改写历史来消除报错。

## 文档、模板与发布

- `docs/ai` 是 AI 指南唯一手写来源。`scripts/error-catalog.ts` 维护逐码解释和例子，`pnpm docs:errors` 生成 `docs/errors`；不要只改生成页面。
- `scripts/sync-template.ts` 同步采购模板和两套模板的共享配置、学习资料。空白模板的领域、页面和初始迁移独立维护；采购参考源码在 docs 下，不参与运行。应用 AGENTS.md 的框架部分由 CLI `sync` 托管，业务约定写在标记外。
- CLI 构建时将模板、AI 指南与错误码册打包；`create-cage-app` 仅调用 CLI。新项目应能仅靠本地文件完成学习，不能要求用户另行克隆框架。
- 模板中的 `_gitignore` 在创建后恢复为 `.gitignore`；npm 会排除原名，不能把占位文件直接改回原名分发。
- 更改指南或错误码后执行文档检查；更改托管区后同步范例，再同步模板并构建 CLI，避免发布旧资料。
- 本仓库远端为 `https://github.com/shunshunyue/cage.git`；没有可用提交基线时使用 `cage impact --base-file`。不要擅自创建或推送远端。
- npm 包位于 `@yss123`，统一版本和发布步骤见 [npm 发布说明](docs/npm发布说明.md)。公开发布不能覆盖同版本，只在用户授权范围内执行。
