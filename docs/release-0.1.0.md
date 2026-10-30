# 0.1.0 发布记录

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
| npm 注册表安装 | 通过；普通 pnpm create 入口创建新项目、安装、构建、check 和 gen --check 均通过，未设置 file/link 覆盖 |

本机最初 Docker 未运行，启动 Docker Desktop 后才执行数据库回归。此次没有改动内核业务逻辑。

首版包准备就绪不代表全设计完成，已有功能边界仍见 [设计实现对照表](design-coverage.md)。详细发布步骤见 [npm 发布说明](npm发布说明.md)。

## 发布进度

- 本地源码已提交，初始发布准备提交为 `8ca6883`。
- npm 已确认账号邮箱和 2FA 有效；十个包的 dry-run 全部通过。
- 十个 `0.1.0` 包全部公开发布，逐包查询注册表均返回 200。
- 首轮批量命令在第二个包的浏览器认证轮询阶段遇到 404；改为账号持有人在可见终端逐次认证后，剩余九包发布命令返回 0。npm 对新包有短暂处理时间，已等到十个包全部可下载后再验证。
- GitHub `main` 已上传成功。HTTPS 直连、代理及旧凭证曾阻断上传，最终使用 Windows 系统 OpenSSH，经 `ssh.github.com:443` 验证为 `shunshunyue` 并完成推送；origin 的 HTTPS 地址保留。
- 已在仓库外运行 `pnpm create @yss123/cage-app@0.1.0 application`，完成安装、构建与声明检查；没有使用本地源码或 tarball 覆盖。

npm 入口：[创建工具](https://www.npmjs.com/package/@yss123/create-cage-app)、[CLI](https://www.npmjs.com/package/@yss123/cage-cli)、[内核](https://www.npmjs.com/package/@yss123/cage-kernel)。
