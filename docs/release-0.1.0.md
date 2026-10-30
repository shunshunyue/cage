# 0.1.0 发布准备记录

日期：2026-10-30；npm 账号 `yss123`；仓库 <https://github.com/shunshunyue/cage>；许可证 MIT。

## 本次整理

- 十个 npm 包使用 `@yss123/cage-*` 和 `@yss123/create-cage-app`，补齐公开发布配置、源码地址、README、MIT 和 Node.js 24 要求。
- CLI、模板、升级与 AGENTS 版本统一从包清单读取；提供 `release:version`、`release:prepare`、`release:pack`、`release:smoke`。
- 检查实际 tarball 的入口、分发资源、许可证和依赖转换；源码提交排除 `.env`、数据库、运行记录和发布压缩包。
- 修复已安装 CLI 的模板过滤问题：只按模板内部相对路径排除运行目录，不误过滤父级 `node_modules`。
- 添加首版手动发布说明，以及后续手动触发、使用 GitHub OIDC 的 npm 发布工作流。没有配置 npm token。

## 验证

| 检查 | 结果 |
| --- | --- |
| 框架及采购范例构建 | 通过；第三方 use client/PURE 提示不影响构建 |
| 十个 npm tarball 的内容检查 | 通过，包含模板、图谱、错误码册及声明入口 |
| 仓库外安装及生成项目 | 通过；安装 tarball、创建、安装业务依赖、构建、check、gen --check、sync --check |
| 真实 Docker PostgreSQL 框架回归 | 通过，框架测试命令返回 0 |
| 采购范例完整 verify | 通过，91 个通过、10 个原有跳过；0 失败 |
| 框架预算 | 通过：3330 行、15 组原语、0 unsafe |
| 文档链接 | 已检查的 69 个本地链接有效 |
| 浏览器与生产部署 | 本次未执行，未改业务交互 |
| GitHub Linux CI / Trusted Publisher | 配置已写，尚待远端执行验收 |
| npm 注册表安装 | 需实际发布后验证，tarball 验证不替代注册表验证 |

本机最初 Docker 未运行，启动 Docker Desktop 后才执行数据库回归。此次没有改动内核业务逻辑。

首版包准备就绪不代表全设计完成，已有功能边界仍见 [设计实现对照表](design-coverage.md)。详细发布步骤见 [npm 发布说明](npm发布说明.md)。
