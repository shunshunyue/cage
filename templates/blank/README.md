# Cage 空白业务项目

这是可直接开发业务的 TypeScript + React 项目，框架由 `@yss123/cage-*` npm 包提供。当前仅注册用户、部门、角色基础模型，保留登录、权限、系统管理、审计和异步任务；没有采购、库存、审批演示声明或演示业务表。

先读 [AGENTS.md](AGENTS.md) 和 [业务开发指南](docs/ai/README.md)。给 Codex 等工具描述自己的业务需求，按 [任务配方](docs/ai/recipes.md) 开发即可。[采购范例导读](docs/ai/purchase-example.md) 对应 `docs/examples/purchase-admin` 中的参考源码；这些文件不参与编译、领域注册或迁移。

## 首次启动

需要 Node.js 24、pnpm 10，以及一个**已经存在**的 PostgreSQL 数据库。框架负责连接和表结构，不创建数据库，不管理 Docker。

1. 在项目根目录执行 `pnpm install`。
2. 复制 `.env.example` 为 `.env`。按其中注释，仅填写 `CAGE_ADMIN_DATABASE_URL`，指向已有数据库。密码含特殊字符时需 URL 编码。
3. 执行 `pnpm exec cage init`。自动创建运行、只读、迁移账号和随机密码，填写 `.env` 并移除管理员连接；已有配置不会重置密码。
4. 执行 `pnpm build:app`、`pnpm gen`。审查 `db/migrations` 后执行 `pnpm migrate`，创建本项目需要的组织与系统表。
5. 执行 `pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json` 显式初始化组织；凭证只写到新的受限文件，交付后移除。业务能力需管理员配置。
6. 执行 `pnpm dev`，在浏览器打开终端打印的 Web 地址。日常 API 启动不初始化组织或输出密码。

登录后可从“系统管理”配置用户、部门、角色与权限，再按业务需求添加模块。页面不会显示虚构业务数据。`.env` 中三个账号连接同一个数据库；日常运行不需要管理员账号。首次迁移应在为本项目准备的库中执行，接管历史业务表需要额外映射和迁移审查。

前端已配置 React Router：`/login` 登录、`/workspace` 工作台、`/directory/users` 成员列表、`/directory/users/:id` 成员详情，以及应用 404。成员页面只读取已有组织模型，需要 User.read，未增加演示业务或数据。详情可直达、刷新，登录后返回原地址。新增业务与生产 SPA 回退按[路由和浏览器验收指南](docs/ai/routing.md)执行；反向代理示例见 [deploy/nginx.conf](deploy/nginx.conf)。

## 添加第一个业务模块

先读[工程目录与代码组织](docs/ai/project-structure.md)。在 `packages/domain/src/modules/<业务>` 新建声明，通过模块 index.ts 从领域总入口导出；运行 `pnpm exec cage check`、`pnpm gen`，审查生成契约和迁移。在 `apps/web/src/modules/<业务>` 使用 `@app/contracts` 实现页面和表单，通过模块公开入口接入 `app` 导航；共享 UI/工具放 `shared`。最后按需迁移，并由管理员分配新增能力。完整的 Note 对象示例见 [原语与最小业务](docs/ai/primitives.md)。

`src/main.tsx` 只挂载 React 和全局 Provider，业务不平铺到 src 根目录。`cage.config.json` 已启用 `structure: modular`，check/verify 会检查目录和依赖边界；不要关闭检查或将所有业务移入 shared 来消除提示。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 连接已配置的数据库，启动 API、worker 与 Web |
| `pnpm build:app` | 构建领域、API 和 Web |
| `pnpm gen` | 生成契约、SQL、图谱和迁移草稿 |
| `pnpm migrate` | 在已配置库中执行审查后的迁移 |
| `pnpm exec cage graph` | 查看本体图谱；勾选“包含系统组织模型”可看初始组织模型 |
| `pnpm verify` | 完整门禁，数据库测试须使用独立测试集群 |
| `pnpm exec cage verify --skip-tests` | 仅静态门禁，会明确标为不完整 |

配置错误看 `.env.example`，业务错误查 [错误码册](docs/errors/README.md)。不要编辑生成契约或已执行迁移；新增业务需要生成新的迁移。
