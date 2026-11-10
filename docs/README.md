# Cage 文档导航

开发业务从 [框架学习入口](development/README.md) 开始；agent 使用 [Cage 开发 Skill](development/skills/cage-development/SKILL.md)。本目录按用途分层，当前用法、设计讨论和历史验收各有入口。

框架原生 AI 的模型接入、智能助理和 AI 审批，见[原生 AI 能力指南](development/guides/intelligence.md)。

Skill 负责引导 agent 的工作与判断，教材解释框架能力和具体做法。用户描述或业务文档不清楚时，按[业务澄清与共同设计](development/guides/business-collaboration.md)提出疑问、选项和建议，再把用户的选择落实到项目业务规则与验收。

| 目录 | 放什么 | 阅读入口 |
| --- | --- | --- |
| `development/` | 使用 Cage 开发应用的教材、能力指南、规范、工具、示例和 Skill，供开发者与编程 Agent 共用 | [学习路径](development/README.md) |
| `errors/` | 从错误码源资料生成的逐码手册，以及 HTTP 运行时错误说明 | [按错误码排查](errors/README.md) |
| `manual/` | 既有综合使用手册与协议说明，版本范围以各页开头为准 | [综合说明](manual/使用说明.md)、[导入导出协议](manual/导入导出.md) |
| `maintainers/` | 框架维护、发布操作、环境配置与教学效果评估 | [发包步骤](maintainers/npm发布说明.md)、[数据库配置](maintainers/local-postgres.md)、[agent 评估](maintainers/agent-evaluation.md) |
| `design/` | 架构提案、路线图和设计实现对照，包含尚未实现的内容 | [AI 后端设计](design/ai-backend-design.md)、[MCP 提案](design/mcp-design.md)、[OA 路线图](design/oa-flowable-roadmap.md)、[设计对照](design/design-coverage.md) |
| `verification/` | 各次实施与验收记录，描述记录时的状态 | [实施记录](verification/implementation-status.md)、[反馈改进](verification/feedback-refactor.md)、[采购 OA 验收](verification/purchase-oa-verification.md)、[流程时效](verification/approval-operations-verification.md)、[并行审批](verification/approval-parallel-verification.md) |
| `releases/` | 版本发布记录和对应升级说明 | [0.3.2](releases/release-0.3.2.md)、[0.3.1](releases/release-0.3.1.md)、[0.3.0](releases/release-0.3.0.md)、[0.2.0](releases/release-0.2.0.md)、[0.1.0](releases/release-0.1.0.md) |
| `assets/` | 文档图片和截图，不放业务代码 | [README 视觉资源](assets/readme/README.md)、[截图](assets/screenshots/) |

## 框架教材的层次

```text
development/
├─ README.md          学习总入口
├─ getting-started/   运行模型、第一条业务链、开发步骤
├─ guides/            按需求选择能力并接入
├─ reference/         原语、目录组织、中文注释规范
├─ tools/             能力诊断、本体查询、排错
├─ examples/          教学源码和采购范例导读
└─ skills/            框架开发 Skill 的唯一正文
```

新增文档放入对应用途目录。教学内容维护于 `development/`，错误码维护于 `scripts/error-catalog.ts` 后生成；模板副本与 agent 发现入口通过同步脚本更新。设计提案和历史验收不作为当前 API 用法的证据。

[返回项目首页](../README.md)
