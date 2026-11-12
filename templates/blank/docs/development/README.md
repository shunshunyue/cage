# Cage 开发手册

Cage 用 TypeScript 声明业务对象、允许的操作和后续流程，再从声明构建接口、权限目录、前端契约与迁移草稿。应用开发的主线是：**定义业务 → 导出声明 → 生成并迁移 → 配置授权 → 页面调用 → 验证结果**。

## 第一次使用

按顺序完成三篇即可开始开发：

1. [启动应用](getting-started/start.md)：准备已有数据库，生成账号、迁移并登录。
2. [理解执行模型](getting-started/architecture.md)：弄清聚合、命令、读取、事件和 worker 怎样合作。
3. [完成第一个业务](getting-started/first-feature.md)：实现便笺的创建、读取、修改和归档。

日常修改直接用[开发步骤](getting-started/workflow.md)。编程 AI 读取项目 AGENTS.md 后使用[开发 Skill](skills/cage-development/SKILL.md)，再进入本次需要的指南。

## 按任务查找

| 要完成的事 | 阅读入口 |
| --- | --- |
| 需求有歧义，或不知道怎样划分对象 | [共同确定业务](guides/business-collaboration.md) · [选择声明](guides/recipes.md) |
| 表达业务含义、状态和关系 | [本体建模](guides/ontology-modeling.md) · [对象关系](guides/relations.md) |
| 实现列表、表单和详情 | [前端组件](guides/frontend-ui.md) · [路由与会话](guides/routing.md) |
| 提交、审批、并行会审、转办或催办 | [接入审批](guides/approvals.md) |
| 上传私有附件和断点续传 | [文件](guides/files.md) |
| CSV 导入、导出和任务进度 | [数据传输](guides/transfers.md) |
| 外部系统同步、定时或跨对象联动 | [事件与外部系统](guides/automation.md) |
| AI 审批、随页助理、模型与性格 | [原生 AI](guides/intelligence.md) |
| 了解完整组合业务 | [采购范例导读](examples/purchase-example.md) |

## 查具体规则或定位故障

声明参数查[原语参考](reference/primitives.md)，授权查[权限与范围](reference/authorization.md)，前端结果与版本查[客户端](reference/client.md)。代码组织与注释分别遵守[目录规范](reference/project-structure.md)和[中文注释规范](reference/commenting.md)。

不知道当前版本有没有某个 API，使用[能力与状态诊断](tools/diagnostics.md)；不知道项目在哪里实现，使用[本体检索](tools/ontology-context.md)；操作失败按[排错顺序](tools/troubleshooting.md)找到断点。收到具体 CAGE 码时进入[错误码册](../errors/README.md)。

## 本手册的路径与版本

命令默认在应用根目录执行。框架仓库的应用是 `examples/purchase-admin`；独立脚手架的应用就是新项目根目录。空白模板中的 `docs/examples/purchase-admin` 是阅读用源码，未注册为业务。

教材随 CLI 分发，描述同一版本的用法。已安装 API 用 `pnpm exec cage capabilities 符号 --format json` 查真实签名，生成方法以本项目 contracts 为准。运行结果须由当前应用验证；设计提案与历史验收只能说明各自记录时的事实。
