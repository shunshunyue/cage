# Cage

用 TypeScript 声明聚合、命令、权限、审批和第三方映射。写入经过内核，查询经过 PostgreSQL 安全视图，工具链负责生成和检查。

**使用入口：** [中文使用说明](docs/使用说明.md)（启动、数据库、图谱、命令、新建项目） · [设计实现对照表](docs/design-coverage.md)（完成项、差异与待办）。核心开发链路已可用，整份 v0.1 设计及生产验收尚未全部完成。

**维护者发布：** [npm 发包步骤](docs/npm发布说明.md)。源码仓库为 <https://github.com/shunshunyue/cage>，npm 包使用 `@yss123/cage-*`，创建工具为 `@yss123/create-cage-app`，许可证为 [MIT](LICENSE)。

## 通过 npm 创建项目

`0.1.0` 已发布，Node.js 24、pnpm 10 环境可直接运行：

```powershell
pnpm create @yss123/cage-app@0.1.0 my-app
cd my-app
pnpm install
pnpm build:app
pnpm exec cage db setup
pnpm exec cage db up
pnpm exec cage db init
pnpm dev
```

数据库步骤要求 Docker Desktop 已运行；同时运行多个项目时，先按[使用说明](docs/使用说明.md#9-从模板创建独立项目)设置独立端口。业务项目只依赖 npm 包，不需要框架源码目录。

## 本地运行

要求 Node.js 24+、pnpm 10、Docker Desktop（Linux 容器）。开发库使用 PostgreSQL 18 持久卷，测试使用独立容器。

```powershell
pnpm install
pnpm build
pnpm --filter @app/purchase-admin db:setup
pnpm --filter @app/purchase-admin db:up
# 首次创建数据库时执行一次；后续启动会自动应用未执行的迁移。
pnpm --filter @app/purchase-admin exec cage migrate --init
pnpm --filter @app/purchase-admin dev
```

- 采购工作台默认端口 5173；本机因 Windows 保留端口已在 `.env` 配为 <http://localhost:15173>。
- 系统管理：<http://localhost:3000/admin/>
- 初始管理员账号由 API 首次启动打印。设置部门负责人及采购、审批角色后，可走完整审批链。
- 开发库：`127.0.0.1:54329/cage_dev`；三个角色的连接串保存在示例 `.env`。`cage dev`、`migrate`、`verify` 自动读取，外部环境变量优先。
- 本地 ERP 使用 fake；数据库连接是真实 PostgreSQL。测试集群使用 54330，与开发库隔离。
- 没有配置数据库连接串时，仍支持原有内嵌 PostgreSQL。以前的 `.cage/postgres` 数据保留，未自动导入 Docker。

安装、连接工具和持久化验收见 [docs/local-postgres.md](docs/local-postgres.md)。

## 从模板创建

维护框架或试用尚未发布的本地修改时，可以直接使用当前源码框架：

```powershell
node packages/cli/bin/cage.js create ../my-purchase-app --framework-path F:/cage
cd ../my-purchase-app
pnpm install
pnpm build:app
# 若与示例同时运行，先修改新项目 devDbPort，再生成独立数据库配置。
pnpm exec cage db setup
# 同时运行多个项目时，还需调整 .env 中的 Web/API 端口。
pnpm exec cage db up
pnpm exec cage db init
pnpm dev
```

使用已发布包可直接运行 `pnpm create @yss123/cage-app my-app`，生成的项目统一依赖 `@yss123/cage-*` 版本，不复制框架源码。

端口配置和首次初始化步骤见[使用说明第 9 节](docs/使用说明.md#9-从模板创建独立项目)。日常启动无需运行整套测试；需要验收时，在框架根目录运行 `pnpm test:docker`、`pnpm example:verify`。

## 工具链

本体图谱 Web 工作台随 `@yss123/cage-cli` 分发，独立项目同样可用。在项目根目录运行：

```powershell
cd F:/cage/examples/purchase-admin
pnpm exec cage graph
# 地址被占用时可以指定：pnpm exec cage graph --port 15419
```

打开终端输出的 <http://127.0.0.1:15418>。默认“对象与字段”把每个业务对象呈现为绿色表头的卡片，卡片内按声明顺序展示字段标识、中文含义、类型、必填/引用标记，底部显示字段数、状态数和实际表名。引用线从具体字段行连到目标对象表头；点击字段看详情，拖动表头移动整张卡片。左侧选择业务对象或包含系统组织模型，搜索能定位隐藏对象及长画布中的字段。

“业务流程”查看命令、事件、审批等协作关系；“完整本体”保留所有节点类型的技术视图。卡片模式的“聚焦关联”只保留当前对象的直接引用，聚焦字段时只展示这个字段的引用。卡片展示 domain 声明字段，不等同于数据库完整物理列清单，不补造主外键约束或一对多基数。业务对象在框架中称为**聚合**：把需要统一遵守业务规则的数据、状态和命令作为整体管理，不一定只对应一张表。

连线会显示“包含字段”“确定审批人”“启动审批”等中文关系名。点击线、线上的标签，或节点详情中的“解释”，查看**为什么连接、连接有什么用、箭头怎么读、声明依据及源码位置**。概览仅标注选中节点的关系，其他连线悬停可见；聚焦后只展示当前节点的直接关系。比如“采购审批分支 → 所属部门”说明部门经理审批按部门找负责人，而“采购审批流程 → 所属部门”仅表示允许审批读取该字段。虚线归属和查询文本匹配会明确说明推导依据，不能当作执行记录。

修改 domain 后点击“重新抽取”，服务会在新进程中重新加载声明，同时更新 `.cage/ontology.json`。图规则问题可在页面查看；抽取失败会保留上次成功结果并显示错误。实线是声明关系，虚线是为浏览补充的归属关系。可下载原始 JSON，页面不修改业务声明，不需要数据库。服务仅监听本机，终端按 `Ctrl+C` 关闭。

页面优先显示中文名称，英文标识作为辅助信息保留，搜索支持两种名称。图谱复用声明已有的 `description`；项目也可在 `cage.config.json` 的 `graph` 中设置 `title` 和 `labels`，如 `"labels": { "aggregate:PurchaseOrder": "采购单", "command:PurchaseOrder.approve": "通过审批" }`。显示名独立于本体图哈希，不改数据库、路由和权限标识；没有名称的自定义节点保持原标识，不自动猜译。

`cage --help` 列出所有命令。`gen` 生成契约、状态图、安全 SQL 和迁移草稿；`verify` 运行门禁并写 `.cage/verify.json`；`sync` 只更新 AGENTS.md 托管区；`upgrade --dry-run` 查看版本清单和 codemod 变化。

没有 Git 基线时，先运行 `cage analyze`，把 `.cage/ontology.json` 保存到项目自有路径，再通过 `cage impact --base-file <保存的图>` 比较。Git 模式使用 `--base <提交>`。

生产部署使用三个独立数据库账号，先执行 `cage migrate`，再启动 API/worker。初始化新集群可使用 `cage migrate --init`，需设置 `CAGE_SUPER_DATABASE_URL` 以及三个账号的连接串；不会覆盖已有集群账号密码。

详细设计见仓库中的技术实施方案；本轮验收及限制见 [docs/implementation-status.md](docs/implementation-status.md)。
