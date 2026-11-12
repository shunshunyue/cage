---
name: cage-development
description: 使用 Cage 开发、修改和排查业务应用。先理解需求和现有实现，核对公开能力，再完成声明、页面及业务验收；维护框架源码时遵守仓库 AGENTS.md。
---

# 使用 Cage 完成业务

本 Skill 规定编程 AI 的工作方法。教材和 API 用法由人与 AI 共用；应用内助理的启用另见[原生 AI](../../guides/intelligence.md)。

## 确认任务和入口

读取项目 AGENTS.md、package.json、cage.config.json 及受影响模块。确定应用根目录、domain 导出、contracts 和前端入口，区分正在运行的代码与离线参考。框架维护遵守仓库包边界；文案、样式和排错按实际影响处理。

Cage 的运行主线是：

```text
领域声明 → domain 导出 → 注册表 → 接口、能力、契约与迁移
页面 → 契约 → 内核命令 → 业务数据、审计、事件
读取 → 安全读侧；事件 → 同事务反应，或 worker 异步处理
```

首次接触先读[执行模型](../../getting-started/architecture.md)和[第一个业务](../../getting-started/first-feature.md)。熟悉后直接进入本次任务指南。

## 从规则到实现

1. 用业务语言说明谁要做什么、前后状态和成功条件。沿用用户已明确的规则。
2. 读取已有实现，核对能力与签名。用 `cage capabilities` 查安装包，用 `cage context` 查应用，再阅读命中的源码。未命中时换术语或查公开导出。
3. 遇到影响规则、体验或范围的歧义，引用来源，给出选项、影响和推荐，让用户决定；等待时推进独立工作。技术事实由 agent 查清，可选建议不阻塞已明确任务。推荐、预选、沉默均不作为选择。
4. 编码前简述“已确认规则 → 查证过的框架机制 → 修改位置 → 验收例子”。小改动一两句话即可，普通技术方案无需另设批准。
5. 修改声明与逐层导出，检查和生成，审查迁移，再接真实契约与页面。领域含义变化前保存基线。
6. 按业务例子验证成功与拒绝，说明通过、跳过和未执行。生成成功只证明生成阶段；实际持久化、权限、流程和界面需要各自证据。

共同澄清的方法见[业务协作](../../guides/business-collaboration.md)，声明选择与映射见[业务设计](../../guides/recipes.md)，实施命令见[开发步骤](../../getting-started/workflow.md)。

## 按需加载

| 本次任务 | 先读 |
| --- | --- |
| 对象、状态、命令、查询 | [原语](../../reference/primitives.md)；含义不清再读[本体建模](../../guides/ontology-modeling.md) |
| 本人、部门或敏感字段 | [权限与范围](../../reference/authorization.md) |
| 一对多、多对多 | [关系](../../guides/relations.md) |
| 审批、并行、加签、催办 | [审批](../../guides/approvals.md) |
| 事件、资源、定时、第三方 | [自动化](../../guides/automation.md) |
| 文件、导入导出 | [附件](../../guides/files.md)或[数据传输](../../guides/transfers.md) |
| AI 审批或随页助理 | [原生 AI](../../guides/intelligence.md)，先核对项目启用状态 |
| 页面和导航 | [组件](../../guides/frontend-ui.md)、[路由](../../guides/routing.md)、[客户端](../../reference/client.md) |
| 故障 | [排错](../../tools/troubleshooting.md)，保留 code / at / reason / fix |

## 实施边界

命令承担业务写入；handler 通过显式 reads 读取并返回变化，外部 IO 通过连接器。查询使用安全读侧。页面依赖契约、客户端和协议，正式业务结果以服务端为准。

角色、能力、范围、调用身份与业务约束分别核对；审批选人不授权。框架已有能力、应用启用和实际验证分别说明，能力缺口以证据为依据，不编造 API 或用模拟数据补正式结果。

按[目录](../../reference/project-structure.md)和[中文注释](../../reference/commenting.md)维护源码。生成物从声明生成，已执行迁移保留。失败沿第一个断点修复，保持权限、约束和门禁有效；具体验收口径见[验证参考](../../reference/verification.md)。
