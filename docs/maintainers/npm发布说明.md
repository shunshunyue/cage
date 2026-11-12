# 构建、验收与发布 npm 包

本页用于维护者发布 @yss123 的公开包，命令从框架根目录执行。版本以各包 package.json、CLI 版本及本轮 manifest 为准，发布状态按[对应版本记录](../releases/README.md)核对。

构建压缩包、上传 npm、提交源码和推送标签是不同操作，按用户已有授权分别执行；已发布的同版本不能覆盖。

## 1. 统一版本和说明

需要新版本时使用 pnpm release:version 目标版本，再更新依赖锁、CHANGELOG 和相应升级说明。脚本同步公开包版本，不提交或发布。

每个包 README 说明职责、安装、真实用法和边界。根工程、范例及 @app 工作区为 private；分发不能包含 .env、凭据、运行库、node_modules 或本机 .cage 数据。

## 2. 准备本轮 tarball

```powershell
pnpm install --frozen-lockfile
pnpm release:prepare
pnpm release:smoke
```

prepare 构建包、同步范例托管区和契约、更新错误册及模板，再构建并打包。CLI 必须携带同版本教材、错误码、模板和图谱资源。pack 检查入口、资源、README、依赖版本及文件白名单。

产物位于 .cage/releases/目标版本，manifest.json 记录按依赖排序的包文件及 SHA-512。pnpm pack 将 workspace 引用转换成实际版本，上传这些经过检查的 tgz。

smoke 在仓库外安装真实 tarball，创建并构建两模板，检查声明和生成一致性；发布前使用 tgz 覆盖不代表公开 npm 安装已验证。

## 3. 取得匹配的验证证据

按本轮变更执行框架与范例测试、预算、教材和分发检查。release:prepare 已包含构建；普通文档调整按范围检查，实际发布仍需完整发布前要求。

数据库使用独立测试环境。检查真实报告中的通过、失败和跳过，不只看外层退出码；浏览器、真实模型或第三方结果分别记录。

## 4. 上传经过检查的包

由账号持有人完成 npm 登录和所需认证，用 whoami 核对发布账号。凭据不进入仓库或对话。

手动发布按 manifest 中的依赖顺序逐包执行 npm publish 对应文件，并指定 public、目标 tag 和 registry。正式版本用 latest，预发布用 next。仓库 .github/workflows/release.yml 也上传 manifest 指定 tarball，并校验 Git 标签与 CLI 版本一致。

CI 当前通过手动 workflow_dispatch 触发，使用 npm 环境、GitHub OIDC 和相应 Trusted Publisher 配置。普通源码 push 不自动发布；网站配置与首次实际 CI 成功需另行验证。

批量发布并非原子。部分失败时先查 npm 回执、版本、dist.integrity 和 tag，再处理尚未完成的包；不能用重发覆盖已有版本。

## 5. 验证普通用户安装

上传后核对每个包的版本、tag 与 manifest 的 SHA-512。在仓库外从公开注册表分别创建 blank、purchase，安装、构建、check/gen --check；此时不用源码链接、framework-path 或 tgz 覆盖。

注册表可见、tarball 一致和真实安装分别取得证据。保存本轮包、manifest、日志和核对结果。

## 6. 完成发布记录

将已执行结果和未执行项写入对应版本记录，更新 CHANGELOG 的状态与首页创建示例。npm 完成不自动代表源码已提交、推送或打标签，相关 Git 操作按授权执行。

遇到认证、网络或部分上传失败，保留稳定错误并查实际注册表。旧机器代理、SSH 路径和首版命令不是所有维护环境的默认配置。

[框架维护](framework-development.md) · [文档目录](../README.md)
