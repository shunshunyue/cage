# @yss123/cage-cli

Cage 的开发命令行：创建项目，抽取领域声明，生成契约与迁移草稿，检查图规则与目录边界，浏览业务图谱，查询能力和运行诊断，并管理开发进程及显式迁移。CLI 是开发与部署工具，不能代替业务命令或自动授予生产权限。

## 使用

```powershell
pnpm add -D @yss123/cage-cli
```

首次使用建议通过脚手架创建完整项目，所需依赖由模板统一配置。需要 Node.js 24 或更新版本。

创建的两种模板均携带 `docs/development` 教材、Cage Skill、`.agents/skills/cage-development` 发现入口及 `CLAUDE.md`。agent 从项目 AGENTS 进入，遇到需求或文档疑点时提出选项、影响与推荐，与用户确定业务后实施。`cage sync` 只更新 AGENTS 托管区，已有项目的教材和 Skill 需另行审查合入同版本模板内容。

## 从零开始

```powershell
pnpm exec cage create my-app --template blank
cd my-app
pnpm install
```

在新项目中复制 `.env.example` 为 `.env`，只在本地填写已有 PostgreSQL 数据库的 `CAGE_ADMIN_DATABASE_URL`。然后执行：

```powershell
pnpm exec cage init
pnpm build:app
pnpm gen
```

审查 `db/migrations` 的变更后，再执行：

```powershell
pnpm migrate
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

`init` 准备账号、schema 权限和本地连接配置，不创建数据库、不安装 PostgreSQL 或启动 Docker。`gen` 只生成文件，`migrate` 才变更数据库；bootstrap 显式交付初始凭据，不把它们输出到日志或提交源码。

## 日常开发命令

以下命令在应用根目录运行；`cage.config.json` 定位 domain、contracts、迁移和模块结构。

| 命令 | 解决的问题 |
| --- | --- |
| `pnpm exec cage check` | 声明、目录、依赖与本体图规则检查 |
| `pnpm exec cage gen` | 生成前端 contracts、SQL、状态图和迁移草稿，不手改生成物 |
| `pnpm exec cage capabilities "文件" --format json` | 查当前已安装框架的公开 API 与签名 |
| `pnpm exec cage context "需求关键词"` | 查本应用相关节点、源码和候选证据 |
| `pnpm exec cage graph` | 打开可交互业务图谱 |
| `pnpm exec cage doctor` | 区分注册、生成、迁移、授权和实际进程状态；unknown 不是通过 |
| `pnpm exec cage verify` | 汇总项目门禁与测试；数据库测试需要独立测试配置 |
| `pnpm exec cage sync` | 更新 AGENTS 框架托管区，保留标记外业务约定 |
| `pnpm exec cage upgrade` | 框架升级辅助与检查，使用前阅读当前版本升级说明 |

此外提供 `analyze/impact/test/budget` 等维护入口。可用 `pnpm exec cage --help` 查询参数；包根导出分析、生成、诊断等可组合函数，普通项目优先使用命令行，避免依赖内部文件路径。

`pnpm exec cage create my-app` 交互选择空白业务项目或采购示例项目；也可显式指定 `--template blank` 或 `--template purchase`。省略目录时可交互输入，非交互终端必须同时提供目录与模板。`--framework-path F:/cage` 可链接已构建的本地框架。

自 `0.2.0` 起，两种产物都包含根目录 `AGENTS.md`、`docs/development` 业务开发教材和 `docs/errors` 离线错误码册。空白项目只运行组织模型，采购参考代码在 `docs/examples/purchase-admin`；采购项目运行完整演示链路。让 Codex 等编程工具先读 `AGENTS.md`，无需另行克隆框架源码。

`cage sync` 更新 AGENTS 框架托管区，保留标记外的项目业务约定；它不自动覆盖业务代码或学习资料。

当前创建产物还带有 `.agents/skills/cage-development/SKILL.md` 发现入口，以及引导 Claude 读取同一教材的 `CLAUDE.md`。框架开发方法统一维护在 `docs/development/skills/cage-development/SKILL.md`，按需阅读专题与完整入门课；全部为本地文件，无需向量模型、索引构建或独立服务。不支持 Skills 的工具也可直接按 AGENTS.md 阅读。发现入口不保证每个宿主的自动选择行为，实际加载与业务结果需分别验证。

## 用本体图开发业务

`pnpm exec cage graph` 默认打开业务地图：业务板块 → 流程入口 → 流程图 → 实现代码。板块按模块目录收纳对象，未分模块的项目按对象展示；可通过 `graph.labels` 的 `module:模块目录名` 设置板块中文标题。流程图使用业务节点、审批菱形及方向箭头，保留同事务、异步、条件映射和审批分支。普通滚轮缩放，拖动空白处平移，拖动节点时连线跟随；提供抓手、缩放比例、适应、重排和展开画布，支持横向/纵向布局。点击节点查看同一次抽取的声明代码，保留当前视野与手动布局。地址支持分享、刷新与前进后退；“对象与字段”“完整本体”和复制 AI 上下文仍可使用。

在应用根目录执行：

```powershell
pnpm exec cage context "修改采购单取消逻辑"
pnpm exec cage graph search "取消" --kind command
pnpm exec cage graph inspect command:PurchaseOrder.cancel
pnpm exec cage graph path command:PurchaseOrder.cancel command:InventoryLock.release
pnpm exec cage context command:PurchaseOrder.cancel --format json --out .cage/context.json
```

CLI 每次重新抽取，不需要数据库；报告包含中文候选与依据、业务关系解释、源码位置、契约/前端/测试候选、迁移和授权提示。默认 Markdown；查询支持 `--format json`、`--out`，context 可用 `--depth` / `--limit` 控制范围。图规则错误仍输出可用上下文并返回非零；无命中、精确节点歧义或深度内无路径也非零。Web 节点详情可复制同源 AI 上下文，修改代码后先重新抽取。

名称、SQL 字段和测试匹配是线索；具体执行条件需阅读源码。上述命令自 `0.2.0` 提供，完整流程随新项目分发在 `docs/development/tools/ontology-context.md`。

- [完整使用说明](https://github.com/shunshunyue/cage/blob/main/docs/manual/使用说明.md)
- [框架源码与范例](https://github.com/shunshunyue/cage)
- [问题反馈](https://github.com/shunshunyue/cage/issues)

许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
