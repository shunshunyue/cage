# Cage 0.3.2 发布记录

日期：2026-11-10。状态：14 个包已公开发布，latest 均为 0.3.2，注册表 SHA-512 与 README 和本轮 tarball 一致；blank、purchase 两模板均通过公开 npm 创建、安装、构建和静态检查，新版 Skill 与业务澄清指南完整分发。已发布的 0.3.1 保留。

## 本次变化

框架开发教材从 `docs/ai` 整理到 `docs/development`，将入门、能力指南、规范、工具和示例分开。设计提案、历史验收、维护者资料单独归档；CLI 能力指引、错误码链接与模板跟随新的教材目录。

blank、purchase 两套模板自带 Cage 开发 Skill、`.agents/skills/cage-development/SKILL.md`、`CLAUDE.md` 和 AGENTS 托管入口。Skill 解释框架运行模型、能力选择、实际接入与验收，并要求 agent 阅读后主动提出疑点、给出选项、影响与推荐，让用户选择业务规则，再落实到实现；具体示例见[业务澄清与共同设计](../development/guides/business-collaboration.md)。

新增[第一条完整业务链](../development/getting-started/first-feature.md)及可编译的便笺领域和页面教材，维护者可通过[行为评估](../maintainers/agent-evaluation.md)验证能力选择与多轮协作。本轮修改教材和开发工具指引，没有修改内核业务执行逻辑，也没有新增数据库迁移。

## 新建与已有项目

使用 `pnpm create @yss123/cage-app@0.3.2 my-app --template blank`，采购演示选择 `--template purchase`。项目使用本地教材，不要求克隆框架仓库。

已有项目将所用 `@yss123/cage-*` 依赖统一升级到 0.3.2；`cage sync` 只同步 AGENTS 的框架托管区，`cage upgrade` 也不会自动更新教材或 Skill。要使用本版开发方法，应从同版本新建的临时项目审查并合入 `docs/development`、`docs/errors` 和 `.agents/skills/cage-development`，再按项目已有内容合并 `CLAUDE.md` 的学习入口并执行 `cage sync`。保留项目业务文档、已有自定义 Skill、AGENTS 托管区外的约定和历史迁移；旧 `docs/ai` 有自定义内容时先迁移该内容，不直接覆盖或删除。

## 本轮验收

| 项目 | 状态 |
| --- | --- |
| 框架、范例构建及文档、模板分发 | 通过；120 个错误码、两套模板和 484 个资料文件 |
| CLI 回归、教材编译、脚本类型、预算 | 通过；CLI 173 项通过、无跳过，预算 4387/5000 行、16 个原语、unsafe 0；CLI 自带的隔离数据库测试已执行 |
| 高危依赖审计 | 通过；无 high/critical，保留 2 项 moderate |
| 14 个 tarball 及仓库外 blank/purchase 验收 | 通过；安装、构建、声明、生成一致性、托管区、本体查询和采购路径；两模板教材/Skill 与规范来源一致 |
| npm 上传 | 通过；14 个包均收到成功回执，上传使用已检查的 tarball |
| latest、注册表完整性与 README | 通过；14/14，上传后本地包完整性也保持一致 |
| 公开 npm 创建、安装与构建 | 通过；blank/purchase 均使用公开 npm，无 tarball 覆盖或源码链接；教材、Skill 入口与规范来源一致，声明、生成、托管区、本体查询和采购路径检查通过 |
| 业务数据库与浏览器全量回归 | 跳过；本轮没有运行时业务变更 |
| 独立 agent 多轮行为评估、真实模型与 ERP、生产部署、GitHub 推送与标签 | 未执行 |

本机发布包、manifest 和验证日志保存在 `.cage/releases/0.3.2`。分发与编译验证只能证明资料和示例可用，不能承诺所有 agent 自动正确遵守或已完成真实业务验收。

压缩包验收项目保留在 `C:/Users/hasee/AppData/Local/Temp/cage-package-0.3.2-xgm9li`，公开 npm 验收项目保留在 `C:/Users/hasee/AppData/Local/Temp/cage-npm-0.3.2-rRlkCi`。`validation.json`、`cli-tests.json/log`、`tarball-smoke.log`、`skill-distribution.json`、`publish-results.json`、`registry-verification.json` 和 `registry-smoke.json/log` 记录本轮证据；源码文件摘要见 `source-snapshot.json`。初次公开查询与创建遇到 npm 索引传播延迟，已保存初始记录，传播完成后验收通过，没有重复上传。

本轮未修改依赖约束。审计保留 glob、minimatch 两项 moderate，高危门禁通过；构建保留现有包体积与上游注解提示，采购自定义输入转换仍报告 `CAGE-GEN-003`，由服务端执行最终校验。源码提交、GitHub 推送和标签不在本轮 npm 发布范围内。
