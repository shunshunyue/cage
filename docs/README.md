# Cage 文档

## 使用框架

[开发手册](development/README.md)是人与编程 AI 共用的当前教材：从启动、执行模型和第一个功能开始，按任务查专题，按符号查参考。编程 AI 另使用[开发 Skill](development/skills/cage-development/SKILL.md)和项目 AGENTS.md。

操作失败时先看[排错顺序](development/tools/troubleshooting.md)，收到具体诊断后查[错误码册](errors/README.md)。教材和错误码随脚手架分发，可以本地阅读。

## 维护框架

| 工作 | 文档 |
| --- | --- |
| 修改包、范例、模板与验证 | [框架维护](maintainers/framework-development.md) |
| 连接与测试数据库 | [数据库环境](maintainers/local-postgres.md) |
| 维护教材和检查分发 | [文档维护](maintainers/documentation.md) |
| 评估人和 AI 能否完成任务 | [教学评估](maintainers/agent-evaluation.md) |
| 构建 tarball 与发布 | [npm 发布](maintainers/npm发布说明.md) |

## 查历史

[发布档案](releases/README.md)按版本记录交付与升级；[设计档案](design/README.md)保留提案与路线图；[验收档案](verification/README.md)记录特定时间和环境中的证据。

这些记录中的“当前、已经、尚未”均相对各自日期，不能作为安装版本的 API 手册。旧 manual 链接已转向对应当前指南；图片与截图放在 assets。

当前手写教材只在 docs/development 维护，错误码解释在 scripts/error-catalog.ts 维护。模板及 agent 发现入口通过同步生成，维护规则见文档维护页。

[项目首页](../README.md)
