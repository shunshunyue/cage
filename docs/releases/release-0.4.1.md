# Cage 0.4.1 发布记录

日期：2026-11-11。状态：已完成 npm 发布；14 个公开包的版本和 `latest` 均为 `0.4.1`，注册表 SHA-512 全部核验一致，blank/purchase 均通过公开 npm 消费验证。

## 本次变化

按当前执行模型重写开发教材、Skill、包说明和维护资料，整理入门、专题、API 参考、工具与历史资料的入口。各项说明旁补充相应代码、命令或业务例子，覆盖声明、权限、关系、事件、任务、审批、连接器、文件、数据传输、AI 和前端页面。

教材检查将 46 处源码摘录与真实示例对照，并独立编译 130 个短例，结合真实声明生成契约后检查领域与前端调用。便笺评论的纯 handler 测试独立执行；这些检查不等同于数据库或浏览器验收。

应用 AGENTS 和 Skill 明确先理解业务、阅读已有实现和调用方，再核对当前框架公开 API。`cage context`、图谱、能力检索和诊断命令按问题选择；检索未命中不能推断实现或能力不存在。

CLI 的 `verify` 从真实测试报告统计通过、失败、跳过与待办；未执行测试、存在跳过或没有测试时，不再标记完整验收。`impact` 纳入项目实际测试文件，并将结果描述为尚未执行的验证候选，说明声明图无法覆盖所有代码依赖。两套模板、托管指引和离线教材同步分发。

## 新建与已有项目

新项目使用 `pnpm create @yss123/cage-app@0.4.1 my-app`，采购演示增加 `--template purchase`。

已有项目将使用到的 `@yss123/cage-*` 依赖统一升级至 `0.4.1`，运行 `pnpm install`、`pnpm exec cage sync` 和 `pnpm exec cage gen --check`，审查托管指引与生成差异。客户业务约定继续放在 AGENTS 托管标记之外。本次没有新增数据库结构或要求改写已执行迁移；教材目录和阅读入口按随包的 `docs/development/README.md` 核对。

## 本轮验收

| 项目 | 状态 |
| --- | --- |
| 依赖锁、框架构建与 tarball 检查 | 通过；冻结锁安装、release:prepare 与 14 个包的入口、依赖及资源检查完成 |
| 框架测试 | 通过；504 项通过、0 项跳过（CLI 190、testkit 300、admin 4、lint 10），包含真实 PostgreSQL 回归 |
| 范例静态与数据库验收 | 静态门禁通过；独立内嵌 PostgreSQL 下 128 项通过、29 项跳过，verify 为 ok: true、complete: false，跳过项不计入通过 |
| 教材示例、文档、脚本类型与预算 | 通过；46 处源码摘录、130 个短例、真实契约及页面编译、3 个 handler 用例；源资料和 CLI 内两模板分发检查完成 |
| 高危依赖审计门禁 | 通过；0 高危、0 严重，仍有 glob 与 minimatch 两项中危，详见本轮 audit.json |
| 仓库外 tarball 安装 smoke | 通过；blank/purchase 均完成创建、安装、构建、check、gen --check 与 sync --check；本项未执行数据库测试 |
| npm 上传、SHA-512 和 latest 核验 | 通过；14/14 包的版本为 0.4.1、latest 指向 0.4.1，dist.integrity 均与本轮 manifest 一致 |
| 公开 npm 创建、安装和构建 | 通过；从公开注册表安装创建工具，blank/purchase 均完成创建、安装、构建、check、gen --check 与 sync --check，17 个步骤全部通过；未设置框架源码链接、framework-path 或 tarball 覆盖 |
| 浏览器、真实模型与第三方联调 | 未执行；本次不以静态或 fake 检查替代 |
| Git 提交、推送与标签 | 未执行 |

本轮 tarball、manifest、测试日志、注册表核对与公开消费报告保存在 `.cage/releases/0.4.1`。npm 上传返回 202 后，部分包的公开元数据延迟出现；最终已确认 14 个包的版本、latest 和完整性全部一致，没有重复上传已有版本。

tarball 验证项目保留在 `C:/Users/hasee/AppData/Local/Temp/cage-package-0.4.1-kivNrm`，公开 npm 验证项目保留在 `C:/Users/hasee/AppData/Local/Temp/cage-public-0.4.1-YuDcsX`，用于本机复核。范例最初引用的本地测试实例已停止，本轮通过独立内嵌实例重跑完成数据库验收；项目 `.env` 未改写。npm 发布不代表源码已提交、推送或打 Git 标签。
