# 0.2.0 发布记录与升级说明

日期：2026-11-02；npm 账号 `yss123`。十个框架包已公开发布为 `0.2.0`，`latest` 标签均指向本版，注册表中的 SHA-512 均与已验收 tarball 一致。

## 功能

本版发布双模板、模块目录规范、AI 教材与本体上下文工具、关系字段、业务页异步 CSV 导入导出、中文系统管理界面，以及连接已有数据库的初始化流程。业务数据和本机凭证不会打入包。

新建项目可以固定本次已验收的版本：

```powershell
pnpm create @yss123/cage-app@0.2.0 my-app --template blank
pnpm create @yss123/cage-app@0.2.0 purchase-demo --template purchase
```

## 从 0.1.0 升级

1. 备份业务源码、独立本体图基线与数据库。统一升级所有已使用的 `@yss123/cage-*` 包到 `0.2.0`，不要混用新 CLI 与旧内核。生产角色的新能力仍须管理员授权。
2. 保留原 `.env` 及数据库。移除旧 `db:setup/up/down/status` 等脚本，已有 PostgreSQL 继续连接同一个库。已有三账号连接时不必重新初始化；首次只有管理员连接时使用 `cage init` 准备账号并填写配置。不要输出或提交 `.env`。
3. 执行 `cage sync` 更新 AGENTS 托管区，保留标记外的项目约定。本版 CLI 不自动覆盖现有项目的整套 docs、页面或目录；新建模板自带这些文件。
4. `cage gen` 会将契约整理为 aggregates/queries 目录。生成器只清理识别出的旧生成文件，保留手写扩展；审查差异，前端继续从 `@app/contracts` 公共入口导入。
5. 新模板启用 `structure: modular`。已有项目可按工程指南整理后显式启用，升级不会强制移动手写源码。
6. 审查新增迁移；已执行迁移不能改写。新版本不负责接管任意历史表，dev 不自动执行迁移。
7. 执行 check、生成一致性、类型检查和必要业务测试。导入导出须运行 worker，HTTP 202 只代表接受任务。

`cage upgrade` 的 codemod 仍只包含历史 `caller → invokedBy` 改写，并不自动完成上述业务配置、目录和数据迁移。

## 发布验收

| 验收项 | 结果 |
| --- | --- |
| 框架、范例 API/Web 构建 | 通过 |
| 脚本类型与文档分发检查 | 通过；2 个应用、354 个学习资料文件 |
| 十包 tarball 入口、依赖及资源检查 | 通过；无 workspace/link/file 内部依赖或本机配置 |
| Docker PostgreSQL 18 框架测试 | 137 项通过，无跳过 |
| 采购范例 verify | 类型、依赖、lint、图规则、生成一致性与预算通过；91 项测试通过、10 项派生用例跳过 |
| 两模板仓库外 tarball 安装 | 安装、构建、check、gen/sync 一致性、本体 context/path 通过；未在临时脚手架项目连接数据库 |
| npm 上传、完整性和 latest 标签 | 通过；10/10，版本与 latest 均为 0.2.0，SHA-512 与 manifest 一致 |
| 真实 npm 创建、安装与构建 | 通过；blank、purchase 分别用公开创建入口生成，安装后 CLI 为 0.2.0；构建、check、gen/sync 一致性、context 与采购关系路径通过，无源码链接、tarball 覆盖或本机框架依赖 |
| GitHub/Linux CI、镜像及生产部署 | 本轮未执行 |

跳过用例不计入通过数量；发布验证使用独立可丢弃的 Docker 测试集群，结束后已移除，没有变更业务数据库。

## 源码与发布产物

发布包位于 `.cage/releases/0.2.0`，manifest.json 记录十个 tarball 的 SHA-512。npm 上传使用这批已检查的压缩包。GitHub 推送不属于本次 npm 请求的自动操作。

同目录保留 `validation.json`（数据库与范例验收）、`publish-results.json`（上传回执）、`registry-verification.json`（十包版本/标签/完整性）及 `registry-smoke.json`、`registry-smoke.log`（公开 npm 安装验收）。这些是本机执行记录，不随包发布。真实 npm 创建的两套验证项目位于 `C:/Users/hasee/AppData/Local/Temp/cage-npm-0.2.0-pPeNtm`，保留供查看。
