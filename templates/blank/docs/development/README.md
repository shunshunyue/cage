# Cage 开发手册

Cage 用 TypeScript 声明业务对象、允许的操作和后续流程，再从声明构建接口、权限目录、前端契约与迁移草稿。应用开发的主线是：**定义业务 → 导出声明 → 生成并迁移 → 配置授权 → 页面调用 → 验证结果**。

## 第一次使用

按顺序完成三篇即可开始开发：

1. [启动应用](getting-started/start.md)：准备已有数据库，生成账号、迁移并登录。
2. [理解执行模型](getting-started/architecture.md)：弄清聚合、命令、读取、事件和 worker 怎样合作。
3. [完成第一个业务](getting-started/first-feature.md)：实现便笺的创建、读取、修改和归档。

日常修改直接用[开发步骤](getting-started/workflow.md)。编程 AI 读取项目 AGENTS.md 后使用[开发 Skill](skills/cage-development/SKILL.md)，再进入本次需要的指南。

例如第一次做部门便笺，先让空白应用能登录，再完成声明、列表和归档；已经有应用、只加成员关系时，直接进入关系章节，不必重走首次初始化。

## 跟着代码接一项能力

先完成基础便笺，再按本次需求选取扩展示例；不需要把它们全部注册到项目。正文解释连接步骤，完整教学文件包含 import、声明或组件：

| 想看哪种写法 | 正文与完整代码 |
| --- | --- |
| 带读取依赖和拒绝分支的命令 | [关系课程](guides/relations.md) · [评论声明](examples/note/note-comments.ts) · [成员替换](examples/note/note-members.ts) |
| 同事务联动、定时和出站 | [自动化](guides/automation.md) · [归档记录](examples/note/archive-log.ts) · [任务](examples/note/jobs.ts) · [连接器](examples/note/archive-service.ts) |
| Ant Design 表单、URL 筛选和分页 | [前端组件](guides/frontend-ui.md) · [完整列表](examples/note/notes-table-page.tsx) |
| 结果、版本冲突与同次请求恢复 | [客户端](reference/client.md) · [调用示例](examples/note/note-client.ts) |
| CSV 接受任务后继续查到终态 | [数据传输](guides/transfers.md) · [完整面板](examples/note/transfer-panel.tsx) |
| 部门审批和可编译待办调用 | [审批课程](guides/approvals.md) · [领域](examples/approval/review-request.ts) · [客户端](examples/approval/request-actions.ts) |
| 纯 handler 的成功和拒绝测试 | [验证参考](reference/verification.md) · [评论测试](examples/note/note-comments.test.ts) |

例如关系章节先说明 noteId 属于评论，再紧接创建评论的命令；读到 manyToMany 替换规则时，就地看到完整替换和增量追加。完整文件用来补齐 import 与目录，不代替正文示例。

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

例如“要给便笺加评论和成员”选关系，“要归档后自动推外部”选自动化，“同一页面嵌入助理”选原生 AI；先按本次任务进入，再按代码里实际依赖补读。

## 查具体规则或定位故障

声明参数查[原语参考](reference/primitives.md)，授权查[权限与范围](reference/authorization.md)，前端结果与版本查[客户端](reference/client.md)。代码组织与注释分别遵守[目录规范](reference/project-structure.md)和[中文注释规范](reference/commenting.md)。

理解已有业务先阅读项目入口、相关模块、调用方与测试。框架 API 不明确时查公开类型或[能力诊断](tools/diagnostics.md)；需要梳理跨模块声明关系时可用[本体检索](tools/ontology-context.md)辅助定位；操作失败按[排错顺序](tools/troubleshooting.md)找到断点。收到具体 CAGE 码时进入[错误码册](../errors/README.md)。

例如命令返回 CONFLICT，查客户端的版本处理；若生成时报 CAGE-GEN-001，则查错误码和生成差异。两者都叫“保存没成功”，实际应沿各自证据处理。

## 本手册的路径与版本

命令默认在应用根目录执行。框架仓库的应用是 `examples/purchase-admin`；独立脚手架的应用就是新项目根目录。空白模板中的 `docs/examples/purchase-admin` 是阅读用源码，未注册为业务。

教材随 CLI 分发，描述同一版本的用法。已安装 API 用 `pnpm exec cage capabilities 符号 --format json` 查真实签名，生成方法以本项目 contracts 为准。运行结果须由当前应用验证；设计提案与历史验收只能说明各自记录时的事实。

例如 blank 项目的 docs/examples/purchase-admin 是离线采购参考；当前业务代码应写到自己的 packages/domain/src。修改参考文件不会给当前应用增加采购能力。
