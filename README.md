# Cage

Cage 是面向业务应用的 TypeScript 框架。开发者和 AI 把对象、状态、操作、权限归属及后续流程写成声明，框架用同一份声明执行应用、生成前端契约，并提供可检索的业务上下文。

![Cage 业务框架](docs/assets/readme/hero.webp)

## 应用怎样构成

```text
domain 业务声明 → 注册表 → HTTP、能力与运行时
                       → contracts、迁移草稿与本体图
Web → contracts → 命令事务 / 安全读取
事件 → 同事务反应，或 worker → 审批、任务、连接器
```

命令是业务写入口，内核统一处理能力、范围、状态、版本、约束、审计和 outbox。页面通过生成契约读写，读取使用 PostgreSQL 安全视图；第三方写入由连接器承担。

业务应用保留自己的模型、规则和界面，API/worker 入口只负责装配。框架不预设客户必须使用采购流程。

![一份声明连接运行、生成与业务上下文](docs/assets/readme/business-model.svg)

## 创建并运行

需要 Node.js 24+、pnpm 10 和一个已存在的 PostgreSQL 数据库。当前源码包版本为 0.4.0，创建示例使用相同版本：

```powershell
pnpm create @yss123/cage-app@0.4.0 my-app
cd my-app
pnpm install
Copy-Item .env.example .env
```

选择 blank 得到登录、组织与系统管理；选择 purchase 另带采购演示。按 .env.example 填写管理员数据库连接后：

```powershell
pnpm exec cage init
pnpm build:app
pnpm gen
# 审查 db/migrations 中的草稿：
pnpm migrate
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

打开终端打印的 Web 地址，使用受限文件交付的凭据登录，交付后移除凭据文件。init 准备账号，migrate 更新结构，bootstrap 显式初始化组织；日常 dev 启动进程。完整前提与失败处理见[启动指南](docs/development/getting-started/start.md)。

## 学习和开发

第一次使用按[开发手册](docs/development/README.md)学习执行模型并完成便笺读写。日常任务直接进入审批、关系、附件、自动化等指南。

| 需要什么 | 入口 |
| --- | --- |
| 理解运行、实现第一个功能 | [执行模型](docs/development/getting-started/architecture.md) · [便笺课程](docs/development/getting-started/first-feature.md) |
| 用 AI 编写业务 | 项目 AGENTS.md · [开发 Skill](docs/development/skills/cage-development/SKILL.md) |
| 查 API、规则与当前项目 | [原语](docs/development/reference/primitives.md) · [能力诊断](docs/development/tools/diagnostics.md) · [本体检索](docs/development/tools/ontology-context.md) |
| 查运行失败 | [排错](docs/development/tools/troubleshooting.md) · [错误码](docs/errors/README.md) |
| 阅读完整组合应用 | [采购导读](docs/development/examples/purchase-example.md) |

脚手架自带同版本本地手册与示例源码。AI 从需求、声明和真实签名查证实现，按业务结果验收；静态图和构建只证明各自检查范围。

## 让应用使用原生 AI

应用从 domain 导出 ai() 后，可以启用领域助理和 AI 审批。助理读取获授权的对象、查询与命令，页面提供当前对象、选择和草稿；AI 审批使用现有 step 的 AI 类型，支持通过、退回和人工接管。

框架提供持久会话、工具、确认、回执、流式 SDK、模型与性格管理；应用负责审核政策、授权和界面。模型质量、协议兼容与实际权限需要真实验收，见[原生 AI 指南](docs/development/guides/intelligence.md)。

![采购范例中的随页助理和 AI 审批](docs/assets/readme/intelligent-application.webp)

## 维护框架与版本

仓库包含 kernel、HTTP、组织、审批、文件、客户端、AI、本体和 CLI 等包，使用 pnpm workspace。维护前读 [AGENTS.md](AGENTS.md)，修改与发布分别遵守[框架维护](docs/maintainers/framework-development.md)和[npm 发布](docs/maintainers/npm发布说明.md)。

[版本记录](CHANGELOG.md)与[发布档案](docs/releases/README.md)说明各版本交付；深层手册对应当前源码/随包版本。历史设计与验收从[文档目录](docs/README.md)进入。

[GitHub](https://github.com/shunshunyue/cage) · [反馈](https://github.com/shunshunyue/cage/issues) · [MIT](LICENSE)
