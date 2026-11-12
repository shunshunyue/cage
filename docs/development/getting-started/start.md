# 启动应用并完成首次登录

本篇完成从一个已创建的 Cage 项目到登录系统管理。需要 Node.js 24+、pnpm 10 和一个已存在的 PostgreSQL 数据库；数据库服务由你的环境提供。

## 确定执行目录

独立项目就在包含 package.json、cage.config.json 和 .env.example 的根目录操作。框架源码仓库先在根目录运行 `pnpm install`、`pnpm build`，再进入 `examples/purchase-admin`。

还没有独立项目时，运行 `pnpm create @yss123/cage-app@0.4.0 my-app`，选择 blank 或 purchase，然后进入 my-app。blank 带登录和组织基础；purchase 另带完整采购演示。

## 准备连接和账号

在应用根目录执行：

```powershell
pnpm install
# 首次复制；已有 .env 时编辑原文件。
Copy-Item .env.example .env
```

按 .env.example 的说明填写 CAGE_ADMIN_DATABASE_URL，指向已经存在的库。密码特殊字符需要 URL 编码。然后运行：

```powershell
pnpm exec cage init
```

init 为 API/worker、安全读取和迁移准备不同账号，生成随机密码与 Cookie 密钥并写回 .env；成功后移除文件中的管理员连接。三个账号连接同一个数据库。已有 Cage 集群角色时复用原凭据，init 不会重置其他项目的密码。

部署平台也可直接提供 APP、READ、MIGRATE 连接及 Cookie 密钥。配置值应留在本机或部署密钥中。

## 构建、生成和迁移

```powershell
pnpm build:app
pnpm gen
# 审查 db/migrations 中的结构变化，再执行：
pnpm migrate
```

build:app 构建应用；gen 生成 contracts、结构说明和迁移草稿；migrate 才把结构应用到数据库。服务启动不会自动执行迁移。

首次初始化组织：

```powershell
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

凭据目标必须是新文件，父目录需存在；gen 已创建 .cage。bootstrap 在组织事务提交前交付受限凭据文件，交付失败会回滚初始化。租户已有用户时保留现有账号和密码。

首次超级管理员持有受控的 * 授权，可使用当前及以后新增的能力和本租户全部数据范围。普通角色仍由管理员显式分配能力与范围；升级已有组织不会自动把旧角色改成超级管理员。交付后移除初始凭据文件。

## 确认启动结果

打开终端打印的 Web 地址，使用凭据登录，进入系统管理查看部门、用户和角色。API 与 worker 应连接同一库、加载相同 domain。修改 .env 后重启相关进程。

常见断点：

| 现象 | 检查 |
| --- | --- |
| init 连不上库 | 库是否存在、管理员连接是否正确、集群已有账号是否沿用凭据 |
| gen 找不到声明 | 应用是否构建、domain 入口和配置路径是否正确 |
| 服务提示缺表或迁移 | 审查并运行 migrate，然后重启 API/worker |
| 能登录却不能做业务 | 普通角色的能力、数据范围及业务前提 |
| 有页面却没有待办或任务结果 | worker、实际事件与消费者记录 |

完整排查见[排错方法](../tools/troubleshooting.md)。接下来阅读[执行模型](architecture.md)，再完成[第一个业务](first-feature.md)。

[返回开发手册](../README.md)
