# @yss123/cage-cli

Cage 的开发与部署工具：创建应用，检查声明，生成契约/迁移，查看图谱，查询公开能力和运行证据，启动进程并显式迁移。它使用项目内配置，不代替业务命令。

## 创建与启动

Node.js 24+。已有应用安装 pnpm add -D @yss123/cage-cli，新项目使用 pnpm create @yss123/cage-app。生成后按本地 docs/development/getting-started/start.md 完成：

安装 → .env 配置已有库 → cage init → build:app/gen → 审查后 migrate → bootstrap 交付凭据 → dev。

单独命令用 pnpm exec cage，项目脚本用 pnpm gen、pnpm verify 等。API/worker 使用已配置数据库；普通启动不建库、迁移或重置组织。

## 按问题选择命令

| 任务 | 命令 |
| --- | --- |
| 核对安装版本的公开 API | capabilities 关键词，或直接阅读公开类型 |
| 辅助定位声明与跨模块关系 | context、graph search/inspect/path；实现仍需读源码 |
| 浏览模型 | graph |
| 修改与产物 | check、gen、gen --check、migrate |
| 比较变化 | snapshot save/list、impact |
| 运行证据 | doctor、timeline、explain |
| 测试与门禁 | test、verify、budget |
| 项目指引 | sync；升级先 upgrade --dry-run |

查询与诊断按问题使用，无需在每次修改前后依次运行。gen 自带声明检查，verify 已包含声明与生成一致性等门禁，同一份代码无需重复跑相同检查。

doctor 区分 pass/fail/unknown，退出码 2 表示诊断证据不完整。test/verify 的退出码 0 只说明未发现失败，仍需检查 skip/todo；verify 省略测试、存在跳过或无用例时 complete 为 false。工具通过不能代替业务与浏览器验收；诊断运行接口需要受权会话。

## 教材与分发

CLI 包含两模板、本地开发手册、教学源码、错误码及 Skill 发现入口。AGENTS 说明项目边界，Skill 指导 AI 按任务工作，人与 AI 共用指南。

sync 只更新 AGENTS 托管区，客户规则留在标记外；已有项目的教材需从同版本资料审查合入。生成契约从 domain 更新，已执行迁移保留。

[开发手册](https://github.com/shunshunyue/cage/blob/main/docs/development/README.md) · [日常操作](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/workflow.md) · [诊断](https://github.com/shunshunyue/cage/blob/main/docs/development/tools/diagnostics.md)
