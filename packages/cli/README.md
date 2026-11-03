# @yss123/cage-cli

cage 命令行：init、gen、check、graph、context、impact、test、verify、budget、sync、upgrade、dev、migrate

Cage 是通过 TypeScript 声明业务、由框架统一执行权限和数据规则的中后台框架。此包是框架的一部分。

## 使用

```powershell
pnpm add -D @yss123/cage-cli
```

首次使用建议通过脚手架创建完整项目，所需依赖由模板统一配置。需要 Node.js 24 或更新版本。

`pnpm exec cage create my-app` 交互选择空白业务项目或采购示例项目；也可显式指定 `--template blank` 或 `--template purchase`。省略目录时可交互输入，非交互终端必须同时提供目录与模板。`--framework-path F:/cage` 可链接已构建的本地框架。

自 `0.2.0` 起，两种产物都包含根目录 `AGENTS.md`、`docs/ai` 业务开发教材和 `docs/errors` 离线错误码册。空白项目只运行组织模型，采购参考代码在 `docs/examples/purchase-admin`；采购项目运行完整演示链路。让 Codex 等编程工具先读 `AGENTS.md`，无需另行克隆框架源码。

`cage sync` 更新 AGENTS 框架托管区，保留标记外的项目业务约定；它不自动覆盖业务代码或学习资料。

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

名称、SQL 字段和测试匹配是线索；具体执行条件需阅读源码。上述命令自 `0.2.0` 提供，完整流程随新项目分发在 `docs/ai/ontology-context.md`。

- [完整使用说明](https://github.com/shunshunyue/cage/blob/main/docs/使用说明.md)
- [框架源码与范例](https://github.com/shunshunyue/cage)
- [问题反馈](https://github.com/shunshunyue/cage/issues)

许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
