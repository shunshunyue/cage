# @yss123/cage-admin

组织模型声明与 `/admin/` 系统管理。提供用户、部门、角色、能力授权、数据范围和防提权规则，以及配套的系统管理接口和页面。适合 Cage 应用的基础组织与运营管理；业务审批、文件和 AI 管理入口按实际启用能力提供。

## 使用

```powershell
pnpm add @yss123/cage-admin
```

首次使用建议通过脚手架创建完整项目，所需依赖由模板统一配置。需要 Node.js 24 或更新版本。

## 注册组织模型并初始化

在应用 `packages/domain/src/index.ts` 保留这一行，同时导出自己的业务模块：

```ts
/** 组织声明与业务共同进入注册表；导入本模块不创建账号或连接数据库。 */
export * from '@yss123/cage-admin/domain';
```

标准 API 通过 `@yss123/cage-http` 的 `createServer({ domain })` 自动装配管理接口和静态页面，默认开启 `/admin/`，不需要另写管理路由。API 与 worker 使用同一 domain；前端不要导入本包服务端入口。

在脚手架项目中填写已有 PostgreSQL 数据库的本地配置，运行 `pnpm exec cage init`、构建与 `pnpm gen`，审查后执行 `pnpm migrate`。然后显式初始化组织：

```powershell
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

初始凭据只交付到新的受限文件，交付后移除；不要提交到 Git 或贴入日志。服务启动不会自动重置管理员密码。管理员再配置用户、部门、角色、业务命令能力与数据范围；新增业务能力不会自动授予生产角色。

| 公开入口 | 用途 |
| --- | --- |
| `@yss123/cage-admin/domain` | `Dept/User/Role` 聚合及创建、修改、角色分配和授权命令，供 domain 组合 |
| `bootstrapOrg` | 受控初始化工具调用的组织准备，普通服务启动不调用 |
| `adminRoutes`、`adminCatalog` | HTTP 装配层的管理接口与展示目录 |
| `noEscalation`、`noEscalationViaRoles`、`noWiderScope`、`knownCapability` | 组织授权命令使用的防提权与能力目录约束 |
| `hashPassword` | 服务端密码处理辅助函数，不在浏览器调用或存储明文 |

角色选人、菜单显示和中文标签不授予权限。最终写入通过命令执行，授权变更也受当前操作者的能力与范围约束。`grantAll/grantAllToSuperadmin` 是显式管理工具，不应在日常启动或升级中自动执行。

## 中文管理界面

启动 API 后访问 `/admin/`。页面包含审批待办、用户与部门、角色与授权、操作审计、异步任务和第三方同步。角色页按业务对象分组展示权限，支持中文或代码搜索；操作权限即时保存，数据范围与审批额度需要点击各自的保存按钮。中文显示不改变真实权限标识，也不会自动给角色增加权限。

业务聚合和命令应填写中文 `description`。项目根目录 `cage.config.json` 的 `graph.labels` 同时用于图谱和系统管理，无需再维护一份翻译：

```json
{
  "graph": {
    "labels": {
      "aggregate:PurchaseOrder": "采购单",
      "command:PurchaseOrder.submit": "提交审批",
      "capability:PurchaseOrder.export": "导出采购单",
      "approval:poApproval": "采购审批流程",
      "event:OrderSubmitted": "采购单已提交",
      "job:expireStaleOrders": "清理过期草稿"
    }
  }
}
```

以上是合并进已有配置的片段，不要覆盖项目中的 domain、contracts 等设置。修改显示名后重启 API。API 进程应在项目根目录启动；Docker 模板也会复制这份配置到运行时镜像。

名称优先级：权限专用 `capability:` → `command:` → 命令 `description` → 常用动作中文；业务对象使用 `aggregate:` → 聚合 `description`。read/export 会自动组合对象中文名，敏感字段明文权限和调用方也会显示中文。框架无法凭代码猜测自定义业务术语，缺少中文时需要在声明或配置中补充。

直接集成 HTTP 服务时，也可以通过 `createServer({ domain, adminLabels: { 'aggregate:Document': '业务单据' } })` 提供显示名；它覆盖本地 `graph.labels`。此选项属于 `@yss123/cage-http`，不是领域授权配置。

## 维护管理前端

`ui/src/app` 负责页面组合，`ui/src/modules` 按管理功能组织，`ui/src/shared` 放请求、标签和 DOM 组件。界面由 TypeScript 编译成原生浏览器模块，不要求业务项目使用特定前端框架。执行 `pnpm build` 同时构建接口与界面；发布时分发 `ui/dist`、HTML 和 CSS，不直接执行 TypeScript 源码。

- [完整使用说明](https://github.com/shunshunyue/cage/blob/main/docs/manual/使用说明.md)
- [框架源码与范例](https://github.com/shunshunyue/cage)
- [问题反馈](https://github.com/shunshunyue/cage/issues)

许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
