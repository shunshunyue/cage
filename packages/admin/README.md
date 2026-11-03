# @yss123/cage-admin

组织模型声明与 /admin 系统管理

Cage 是通过 TypeScript 声明业务、由框架统一执行权限和数据规则的中后台框架。此包是框架的一部分。

## 使用

```powershell
pnpm add @yss123/cage-admin
```

首次使用建议通过脚手架创建完整项目，所需依赖由模板统一配置。需要 Node.js 24 或更新版本。

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

- [完整使用说明](https://github.com/shunshunyue/cage/blob/main/docs/使用说明.md)
- [框架源码与范例](https://github.com/shunshunyue/cage)
- [问题反馈](https://github.com/shunshunyue/cage/issues)

许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
