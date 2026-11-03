# Cage

用 TypeScript 声明聚合、命令、权限、审批和第三方映射。写入经过内核，查询经过 PostgreSQL 安全视图，工具链负责生成和检查。

**使用入口：** [中文使用说明](docs/使用说明.md)（启动、数据库、图谱、命令、新建项目） · [设计实现对照表](docs/design-coverage.md)（完成项、差异与待办）。核心开发链路已可用，整份 v0.1 设计及生产验收尚未全部完成。

**维护者发布：** [npm 发包步骤](docs/npm发布说明.md)。源码仓库为 <https://github.com/shunshunyue/cage>，npm 包使用 `@yss123/cage-*`，创建工具为 `@yss123/create-cage-app`，许可证为 [MIT](LICENSE)。

## 通过 npm 创建项目

本文对应 `0.2.0`：双模板选择、已有数据库初始化、中文管理界面及本体 AI 上下文。发布状态与验收结果见[发布记录](docs/release-0.2.0.md)。

`pnpm create @yss123/cage-app@0.2.0 my-app` 交互选择模板；脚本中使用 `pnpm create @yss123/cage-app@0.2.0 my-app --template blank` 或 `--template purchase`。业务项目只依赖 npm 包，不需要框架源码目录。

## 本地运行

要求 Node.js 24+、pnpm 10，以及已经存在、可连接的 PostgreSQL 数据库。数据库可以是本机安装、已有容器或远程服务，框架不管理它的生命周期。

```powershell
pnpm install
pnpm build
cd examples/purchase-admin
# 首次配置时复制；已有 .env 时直接编辑，保留现有值。
Copy-Item .env.example .env
# 编辑 .env，只填写 CAGE_ADMIN_DATABASE_URL，连接已有数据库。
pnpm exec cage init
# init 自动创建账号、生成密码并填写 .env。
pnpm gen
# 审查迁移后执行：
pnpm migrate
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

数据库连接统一配置在业务项目根目录的 `.env`，每项用途见 [配置示例](examples/purchase-admin/.env.example)。首次只填管理员连接，`cage init` 自动建立账号、生成密码、写入三个业务连接及 Cookie 密钥，成功后移除文件中的管理员连接。三个业务连接指向同一个数据库，分别使用写入、只读和迁移账号。连接池和事务由框架提供。

- 日常启动执行 `pnpm dev`；表结构变化审查后执行 `pnpm migrate`。启动不建库，也不自动执行迁移。
- Web 地址以终端为准；配置示例使用 <http://localhost:15173>，系统管理为 <http://localhost:3000/admin/>。
- 迁移后显式 `cage bootstrap` 初始化组织，凭据交付到新的受限文件；API 日常启动不输出密码。数据库账号与网页登录账号不同。
- 本地 ERP 使用 fake，数据库连接是真实 PostgreSQL；数据库测试使用独立、可丢弃的集群。

账号权限与本机已有连接记录见 [数据库接入说明](docs/local-postgres.md)。

## 从模板创建

维护框架或试用尚未发布的本地修改时，先构建框架，再创建独立业务项目：

```powershell
node packages/cli/bin/cage.js create ../my-app --framework-path F:/cage
# ↑↓ 选择“空白业务项目”或“采购示例项目”，Enter 确认；也可显式指定 --template blank 或 purchase。
cd ../my-app
pnpm install
Copy-Item .env.example .env
# 填写 CAGE_ADMIN_DATABASE_URL；多个应用同时运行时分别配置 Web/API 空闲端口。
pnpm exec cage init
pnpm build:app
pnpm gen
# 审查迁移后执行：
pnpm migrate
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

生成项目通过依赖使用框架，数据库配置位于新项目的 `.env`，不复制框架源码。详细接入步骤见[使用说明第 9 节](docs/使用说明.md#9-从模板创建独立项目)。

空白模板保留登录、组织权限、系统管理、数据库配置和 AI 指南，没有采购或库存业务表；采购模板包含完整采购链路。空白模板的采购参考代码位于 `docs/examples/purchase-admin`，只供学习。CI/管道中必须明确指定目录和 `--template`，避免交互等待。

## 让 Codex 等编程工具开发业务

当前源码的脚手架把三份协作材料直接放进产物：根目录 `AGENTS.md`、`docs/ai` 业务开发指南与本地标准范例、`docs/errors` 错误码册。入口见[模板 AGENTS](templates/app/AGENTS.md)和[模板业务指南](templates/app/docs/ai/README.md)，用户无需克隆框架仓库。

可以直接给编程工具下达：“先读 AGENTS.md，按 docs/ai/README.md 和 recipes.md，实现我的业务需求。”资料覆盖普通管理对象、单据审批、资源占用与释放、查询报表、第三方、业务页导入导出，以及生成、迁移、授权和验证。

开发前可运行 `pnpm exec cage context "需求关键词"` 获取相关业务、关系解释、源码与验证候选，必要时使用 `graph search/inspect/path`；详细流程见[本体与 AI 上下文](docs/ai/ontology-context.md)。

当前源码新增公开能力检索、统一状态诊断、执行时间线、授权解释、命名快照与有界集合反应。用法见[能力发现与诊断](docs/ai/diagnostics.md)，反馈实施与验证范围见[本轮改进记录](docs/feedback-refactor.md)。这些修改尚未发布到 npm。

维护者修改规范文档后运行 `pnpm docs:errors`、`pnpm template:sync`、`pnpm docs:check`，再构建 CLI。维护脚本统一使用 TypeScript，可运行 `pnpm typecheck:scripts`。

## 工具链

本体图谱 Web 工作台随 `@yss123/cage-cli` 分发，独立项目同样可用。在项目根目录运行：

```powershell
cd F:/cage/examples/purchase-admin
pnpm exec cage graph
# 地址被占用时可以指定：pnpm exec cage graph --port 15419
```

打开终端输出的 <http://127.0.0.1:15418>。默认“对象与字段”把每个业务对象呈现为绿色表头的卡片，卡片内按声明顺序展示字段标识、中文含义、类型、必填/引用标记，底部显示字段数、状态数和实际表名。引用线从具体字段行连到目标对象表头；点击字段看详情，拖动表头移动整张卡片。左侧选择业务对象或包含系统组织模型，搜索能定位隐藏对象及长画布中的字段。

“业务流程”查看命令、事件、审批等协作关系；“完整本体”保留所有节点类型的技术视图。卡片模式的“聚焦关联”只保留当前对象的直接引用，聚焦字段时只展示这个字段的引用。卡片展示 domain 声明字段，不等同于数据库完整物理列清单；关系基数来自 ref/hasMany/manyToMany 声明，集合关系标记为非主表列。业务对象在框架中称为**聚合**：把需要统一遵守业务规则的数据、状态和命令作为整体管理，不一定只对应一张表。完整用法见[对象关系](docs/ai/relations.md)。

连线会显示“包含字段”“确定审批人”“启动审批”等中文关系名。点击线、线上的标签，或节点详情中的“解释”，查看**为什么连接、连接有什么用、箭头怎么读、声明依据及源码位置**。概览仅标注选中节点的关系，其他连线悬停可见；聚焦后只展示当前节点的直接关系。比如“采购审批分支 → 所属部门”说明部门经理审批按部门找负责人，而“采购审批流程 → 所属部门”仅表示允许审批读取该字段。虚线归属和查询文本匹配会明确说明推导依据，不能当作执行记录。

修改 domain 后点击“重新抽取”，服务会在新进程中重新加载声明，同时更新 `.cage/ontology.json`。图规则问题可在页面查看；抽取失败会保留上次成功结果并显示错误。实线是声明关系，虚线是为浏览补充的归属关系。可下载原始 JSON，页面不修改业务声明，不需要数据库。服务仅监听本机，终端按 `Ctrl+C` 关闭。

页面优先显示中文名称，英文标识作为辅助信息保留，搜索支持两种名称。图谱复用声明已有的 `description`；项目也可在 `cage.config.json` 的 `graph` 中设置 `title` 和 `labels`，如 `"labels": { "aggregate:PurchaseOrder": "采购单", "command:PurchaseOrder.approve": "通过审批" }`。显示名独立于本体图哈希，不改数据库、路由和权限标识；没有名称的自定义节点保持原标识，不自动猜译。

`cage --help` 列出所有命令。`gen` 生成契约、状态图、安全 SQL 和迁移草稿；`verify` 运行门禁并写 `.cage/verify.json`；`sync` 只更新 AGENTS.md 托管区；`upgrade --dry-run` 查看版本清单和 codemod 变化。

没有 Git 基线时，先运行 `cage analyze`，把 `.cage/ontology.json` 保存到项目自有路径，再通过 `cage impact --base-file <保存的图>` 比较。Git 模式使用 `--base <提交>`。

生产部署连接已经准备好的数据库和账号；在独立迁移任务中执行 `cage migrate`，再启动 API/worker。迁移账号只配置给迁移任务，业务运行时使用写入和只读账号。

详细设计见仓库中的技术实施方案；本轮验收及限制见 [docs/implementation-status.md](docs/implementation-status.md)。
