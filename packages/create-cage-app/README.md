# @yss123/create-cage-app

从 Cage 模板创建 TypeScript + React 中后台项目。生成领域声明、契约、API、worker、业务 Web 与部署配置，由同版本 `@yss123/cage-*` 包提供框架能力。本包是 `cage create` 的简短命令入口，无需全局安装，也没有供业务导入的运行时 API。

产物自带 `AGENTS.md`、`docs/ai` 业务开发指南、采购标准范例与 `docs/errors` 错误码册。使用 Codex 等编程工具时，让它先读项目根目录 `AGENTS.md`，按 `docs/ai/recipes.md` 开发客户业务，无需克隆 Cage 框架仓库。

## 使用

```powershell
pnpm create @yss123/cage-app my-app
```

交互终端用 ↑↓ 选择，Enter 确认；Ctrl+C 取消不会创建项目。省略项目名时还会询问目录。

| 模板 | 内容 |
| --- | --- |
| 空白业务项目 `blank` | 登录、用户/部门/角色、权限、系统管理和 AI 教材；采购源码仅存于 docs 供参考 |
| 采购示例项目 `purchase` | 完整采购、库存锁、审批、fake ERP 及业务页面 |

脚本或 CI 可跳过选择，必须明确指定目录和模板：

```powershell
pnpm create @yss123/cage-app my-app --template blank
pnpm create @yss123/cage-app purchase-demo --template purchase
```

不指定版本时使用 npm 当前版本；复现某次创建时可在包名后加 `@版本号`。目标目录应尚不存在，创建器不会替你覆盖已有项目。本地框架测试可在源码仓库运行 `node packages/cli/bin/cage.js create ../my-app --template blank --framework-path F:/cage`；普通 npm 使用不传此选项。

首次使用建议通过脚手架创建完整项目，所需依赖由模板统一配置。需要 Node.js 24 或更新版本。

## 创建后如何运行

还需要 pnpm 10 和一个已存在的 PostgreSQL 数据库。进入生成项目并安装依赖：

```powershell
cd my-app
pnpm install
```

复制 `.env.example` 为 `.env`，按注释填写本地 `CAGE_ADMIN_DATABASE_URL`，不要把真实连接串提交到源码。初始化会准备应用、只读与迁移账号，保留配置并移除管理员连接：

```powershell
pnpm exec cage init
pnpm build:app
pnpm gen
```

审查 `db/migrations` 后执行迁移，显式初始化组织，再启动开发环境：

```powershell
pnpm migrate
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

在浏览器打开终端打印的 Web 地址。初始凭据保存在新的受限文件中，交付后移除；API 日常启动不初始化账号或输出密码。框架不创建数据库、不管理 Docker，也不会自动给生产角色授予新增业务能力。

## 在哪里写业务

| 生成目录 | 用途 |
| --- | --- |
| `packages/domain/src/modules` | 聚合、命令、事件、查询和审批，经 domain 根入口导出 |
| `packages/contracts` | `pnpm gen` 生成的前端类型与接口，不手改 |
| `apps/api/src` | API 与 worker 的薄启动入口 |
| `apps/web/src/app` | 路由、Provider 与页面组合 |
| `apps/web/src/modules` | 按业务模块组织页面与交互 |
| `apps/web/src/shared` | 无具体业务归属的共用组件和工具 |
| `db/migrations` | 审查后的数据库迁移，已执行版本不改写 |
| `docs/ai`、`docs/errors` | 本地学习资料和错误排查 |

新增对象后运行 `pnpm exec cage check`、`pnpm gen`，审查迁移，并由管理员配置新能力与数据范围。

空白模板中的采购源码仅位于 `docs/examples/purchase-admin`，不参与运行或建表；采购模板的 ERP 默认 fake 不等于真实联调通过，AI 能力也需模型配置、权限和迁移才能实际使用。

- [完整使用说明](https://github.com/shunshunyue/cage/blob/main/docs/使用说明.md)
- [框架源码与范例](https://github.com/shunshunyue/cage)
- [问题反馈](https://github.com/shunshunyue/cage/issues)

许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
