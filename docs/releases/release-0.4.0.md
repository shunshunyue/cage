# Cage 0.4.0 发布记录

日期：2026-11-11。状态：已完成 npm 发布；14 个公开包均已发布 `0.4.0`，`latest` 均指向 `0.4.0`。

## 本次变化

组织授权使用受控 `*` 标记表示超级管理员能力。加载授权时按当前能力目录展开命令能力，并提供全量数据范围；普通组织管理员不能创建该标记、停用超级管理员角色或移除标记。普通角色仍按显式能力、参数和范围授权。公开 kernel API 移除 `ceiling` 约束原语，相关示例与文档不再描述审批额度约束。

内核与审批路径读取用户授权时传入当前能力目录，并以同一规则合并有效角色、能力和数据范围。审批结论执行前仍需复核当前人员权限。

CLI 将本体命名检查接入静态分析，并调整图谱中的对象、状态、操作和业务流程名称展示；新增本体建模与前端界面指南。采购范例、空白模板和采购模板的教材、生成契约与页面同步更新。

## 新建与已有项目

新项目使用 `pnpm create @yss123/cage-app@0.4.0 my-app`，采购演示选择 `--template purchase`。

升级已有项目时，将使用到的 `@yss123/cage-*` 依赖统一升级至 `0.4.0`，运行 `pnpm install`、`pnpm exec cage gen` 并审查生成差异。公开 kernel 导出移除了 `ceiling`；若业务代码直接导入该原语，需要按当前业务规则改用应用自己的约束实现。已有超级管理员角色使用显式能力记录，不会因升级自动变成 `*` 标记；需按项目维护流程检查授权配置。新增模板指南与本体命名门禁也应审查后合入。

## 本轮验收

| 项目 | 状态 |
| --- | --- |
| 框架构建、CLI 与包测试 | 通过发布所需的 CLI 构建与分发 smoke；本轮未重新运行完整 `pnpm test` |
| 范例静态门禁、生成一致性及托管区 | 通过 |
| 范例派生与项目数据库测试 | 通过；128 项通过、29 项跳过，使用 testkit 内嵌 PostgreSQL |
| 文档、模板分发、脚本类型与预算 | 通过；`pnpm template:sync`、CLI 构建、`pnpm typecheck:scripts` 与 `pnpm release:pack` 已执行 |
| 14 个 tarball 与仓库外安装 smoke | 通过；blank 与 purchase 均完成构建、`cage check`、`cage gen --check`、`cage sync --check`；未运行数据库测试 |
| npm 上传、SHA-512 和 latest 核验 | 通过；14/14 包的 `0.4.0`、`latest` 和注册表 `dist.integrity` 均与 manifest 一致 |
| 公开 npm 创建、安装和构建 | 通过；从公开 npm 创建 blank/purchase，安装、构建、`cage check`、`cage gen --check`、`cage sync --check` 均完成 |
| GitHub 提交、推送与标签 | 未执行 |

本机 tarball、manifest、smoke 日志和注册表核对报告保存在 `.cage/releases/0.4.0`。npm 上传接口曾返回 `202` 并异步建立索引，最终核验已确认 14 个包全部可见。本轮 npm 发布不代表源码已提交、推送或打标签。
