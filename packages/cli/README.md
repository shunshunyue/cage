# @yss123/cage-cli

Cage 的开发与部署工具：创建应用，检查声明，生成契约/迁移，查看图谱，查询公开能力和运行证据，启动进程并显式迁移。它使用项目内配置，不代替业务命令。

## 创建与启动

Node.js 24+。已有应用安装 pnpm add -D @yss123/cage-cli，新项目使用 pnpm create @yss123/cage-app。生成后按本地 docs/development/getting-started/start.md 完成：

安装 → .env 配置已有库 → cage init → build:app/gen → 审查后 migrate → bootstrap 交付凭据 → dev。

单独命令用 pnpm exec cage，项目脚本用 pnpm gen、pnpm verify 等。API/worker 使用已配置数据库；普通启动不建库、迁移或重置组织。

## 按问题选择命令

| 任务 | 命令 |
| --- | --- |
| 找公开 API | capabilities 关键词 |
| 找应用业务和关系 | context、graph search/inspect/path |
| 浏览模型 | graph |
| 修改与产物 | check、gen、gen --check、migrate |
| 比较变化 | snapshot save/list、impact |
| 运行证据 | doctor、timeline、explain |
| 测试与门禁 | test、verify、budget |
| 项目指引 | sync；升级先 upgrade --dry-run |

doctor 区分 pass/fail/unknown，退出码 2 表示证据不完整；verify --skip-tests 也不算完整通过。诊断运行接口需要受权会话。

## 教材与分发

CLI 包含两模板、本地开发手册、教学源码、错误码及 Skill 发现入口。AGENTS 说明项目边界，Skill 指导 AI 按任务工作，人与 AI 共用指南。

sync 只更新 AGENTS 托管区，客户规则留在标记外；已有项目的教材需从同版本资料审查合入。生成契约从 domain 更新，已执行迁移保留。

[开发手册](https://github.com/shunshunyue/cage/blob/main/docs/development/README.md) · [日常操作](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/workflow.md) · [诊断](https://github.com/shunshunyue/cage/blob/main/docs/development/tools/diagnostics.md)
