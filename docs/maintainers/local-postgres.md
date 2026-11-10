# 数据库配置与本机连接记录

当前源码只连接使用者提供的 PostgreSQL 数据库。数据库可以来自本机安装、现有容器或远程服务；CLI 不创建数据库、不管理 Docker。以下本机地址是之前已经配置过的环境记录，不是脚手架固定值。

## 在哪里配置

业务项目根目录的 `.env`，与 `package.json`、`cage.config.json` 同级。采购范例为 `F:/cage/examples/purchase-admin/.env`；新建项目则配置它自己的 `.env`。首次复制 [配置示例](../../examples/purchase-admin/.env.example)，只填写 `CAGE_ADMIN_DATABASE_URL`，再执行 `pnpm exec cage init`。

| 配置 | 账号和职责 |
| --- | --- |
| `CAGE_APP_DATABASE_URL` | `cage_app`：业务写入与后台任务 |
| `CAGE_READ_DATABASE_URL` | `cage_read`：仅通过安全视图读取 |
| `CAGE_MIGRATE_DATABASE_URL` | `cage_migrate`：表结构迁移 |

三个业务连接由 `init` 自动填写，主机、端口、数据库名一致，使用独立权限和随机密码。连接池、事务和安全读侧由内核实现，项目不用编写连接代码。CLI 自动加载 `.env`，已存在的环境变量优先，修改后重启应用。

## 首次接入与日常更新

首次在 `.env` 填写管理员连接，例如 `CAGE_ADMIN_DATABASE_URL=postgresql://postgres:管理员密码@主机:端口/已有数据库名`，执行 `pnpm exec cage init`。命令自动创建角色和授权、生成密码及 Cookie 密钥、填写 `.env`，成功后移除文件中的管理员连接。重复执行验证并复用原凭证，已有 Cage 账号但本项目没有凭证时会提示补充，不会重置其他项目密码。

审查 `db/migrations` 后执行 `pnpm migrate` 更新表、视图与索引；新组织再显式 `pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json` 初始化，通过新受限文件交付凭据。日常直接运行 `pnpm dev`；有表结构变更再手动迁移。已有库中的任意历史表不会被自动识别为框架模型。

## 本机已有连接记录

| 用途 | 地址/名称 |
| --- | --- |
| 开发数据库 | `127.0.0.1:54329/cage_dev` |
| 开发容器 | `purchase-admin-postgres-1` |
| 开发持久卷 | `purchase-admin_postgres-data` |
| 测试集群 | `127.0.0.1:54330/postgres` |
| 采购界面 | <http://localhost:15173> |
| API 与管理页 | <http://localhost:3000/admin/> |

用户名和密码从本机项目 `.env` 读取，不提交 Git。使用 DBeaver、DataGrip 或 pgAdmin 时选择对应账号，`cage_read` 只能按上下文访问安全视图。数据库服务由自己的工具管理，退出 `dev` 只关闭应用。

## 实际验收

- 从容器内查询到 PostgreSQL 18.6，系统、审批扩展及业务迁移均已记录。
- 通过真实 HTTP 登录、创建 `DOCKER-DB-CHECK` 采购单、取消、再查询；容器内 `core.purchase_order` 存在相同 ID，状态为 `cancelled`、版本为 2。
- 容器内审计表记录 create/cancel，worker 将 `OrderCancelled` outbox 标记为 `done`，重试次数为 0。
- 重启开发 PostgreSQL 容器后，同一采购单、状态和版本仍在，证明数据保存在持久卷中。
- 开发服务的数据库连接包含 `cage-kernel`、`cage-grants-listen`、`cage-worker-listen`、`cage-scheduler`，使用 `cage_app` 身份。

测试结果见 `implementation-status.md`。运行 `pnpm test:docker` 验证框架，`pnpm example:verify` 验证示例。测试会创建独立临时数据库，且测试容器与开发持久卷隔离。


上述为此前验收记录。维护者的 `pnpm test:docker` 使用仓库内 Compose 测试环境，它不随业务模板分发。测试会初始化集群级角色，必须使用独立可丢弃集群；正常应用启动没有自动建库行为。
