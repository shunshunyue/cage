# 本地 Docker PostgreSQL 接入

当前开发环境已连接 Docker 中的 PostgreSQL 18.6，API/worker 使用持久数据库。官方镜像为 `postgres:18-bookworm`。

## 框架与项目的职责

| 层 | 负责内容 |
| --- | --- |
| `@yss123/cage-kernel` | PostgreSQL 连接池、事务、业务写入、只读安全视图及数据库角色边界 |
| `@yss123/cage-cli` | 读取配置、随机凭证生成、Docker 生命周期、建库及迁移 |
| 业务项目 | `.env` 连接参数、`compose.yaml` 部署参数、领域声明与薄启动入口 |

项目无需编写 `pg.connect()`、连接池或建库脚本。生成本地凭证已收进 `cage db setup`；`cage db up` 启动容器，`cage db init` 初始化库，`cage db status` 查看状态，`cage db down` 停止容器。package.json 中的 `db:*` 只是一行命令别名。

## 当前连接

| 用途 | 地址/名称 |
| --- | --- |
| 开发数据库 | `127.0.0.1:54329/cage_dev` |
| 开发容器 | `purchase-admin-postgres-1` |
| 开发持久卷 | `purchase-admin_postgres-data` |
| 测试集群 | `127.0.0.1:54330/postgres` |
| 测试容器 | `purchase-admin-postgres-test-1` |
| 采购界面 | http://localhost:15173 |
| API 与管理页 | http://localhost:3000/admin/ |

DBeaver、DataGrip、pgAdmin 等连接工具填写开发地址、数据库 `cage_dev`，用户名使用 `cage_app`、`cage_read` 或 `cage_migrate`，对应密码从 `examples/purchase-admin/.env` 的连接串读取。三个登录角色都不是超级用户；`cage_read` 只能通过安全视图按上下文查询。

本地网页登录凭证见 `examples/purchase-admin/.cage/local-access.md`，与数据库账号不同。原内嵌数据库目录仍保留，没有导入 Docker，原密码不适用于这个新库。

## 每次启动

先确保 Docker Desktop 运行。在 `F:/cage` 执行：

```powershell
pnpm --filter @app/purchase-admin db:up
pnpm --filter @app/purchase-admin dev
```

`cage dev` 自动读取示例 `.env`，使用外部数据库，应用未执行迁移并启动 API、worker、Vite。终端会显示数据库地址和实际端口，不显示数据库密码。退出 dev 只关闭应用进程，Docker 数据库继续运行。

在示例目录运行 `pnpm db:status` 查看健康状态，`pnpm db:down` 停止容器并保留开发持久卷。重新创建容器后，命名卷中的数据仍会加载。

新机器首次设置时，在安装、构建框架后进入示例目录，先执行 `pnpm cage db setup`、`pnpm cage db up`、`pnpm cage db init`。初始化复用 `cage migrate --init` 创建数据库及角色，已有集群使用普通 `cage migrate`。

## 实际验收

- 从容器内查询到 PostgreSQL 18.6，系统、审批扩展及业务迁移均已记录。
- 通过真实 HTTP 登录、创建 `DOCKER-DB-CHECK` 采购单、取消、再查询；容器内 `core.purchase_order` 存在相同 ID，状态为 `cancelled`、版本为 2。
- 容器内审计表记录 create/cancel，worker 将 `OrderCancelled` outbox 标记为 `done`，重试次数为 0。
- 重启开发 PostgreSQL 容器后，同一采购单、状态和版本仍在，证明数据保存在持久卷中。
- 开发服务的数据库连接包含 `cage-kernel`、`cage-grants-listen`、`cage-worker-listen`、`cage-scheduler`，使用 `cage_app` 身份。

测试结果见 `implementation-status.md`。运行 `pnpm test:docker` 验证框架，`pnpm example:verify` 验证示例。测试会创建独立临时数据库，且测试容器与开发持久卷隔离。

## 本次处理的问题

Docker Desktop 原先未启动，启动后发现 Windows 把 5173 纳入保留端口，故本机设置 `CAGE_WEB_PORT=15173`。保留端口没有修改；模板仍以 5173 为默认值。

Turbo 的严格环境模式原先会过滤测试连接串，现已显式传递 `CAGE_TEST_DATABASE_URL`。并行测试还会竞争 PostgreSQL 集群账号，现改为在共同管理库上取得咨询锁，串行化账号初始化，业务测试继续并行；不再依赖捕获异常后重试。

`.env` 不进入 Git、模板或镜像；模板仅分发 `.env.example`，凭证生成实现随 CLI 升级。真实 ERP 服务仍使用 fake，数据库和应用持久化链路已接入真实 PostgreSQL。
