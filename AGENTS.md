# Cage 框架仓库约定

本仓库实现框架本身；业务应用位于 `examples/purchase-admin`，可分发模板位于 `templates/app`。

## 开发方式

- 使用 TypeScript、pnpm workspace，运行 `pnpm install`、`pnpm build`、`pnpm test`。
- 新代码写清职责、关键流程和设计原因。注释重点解释为什么；避免没有业务价值的防御分支和静默兜底。
- 内核保持业务无关；需要修改内核时说明必要性，用回归用例证明行为，发布前由架构负责人评审。
- 业务写入走命令，读侧走安全视图，外呼走连接器；新增能力不自动授给生产角色。
- 不手改契约等生成物。修改 domain 后运行 `pnpm --filter @app/purchase-admin gen`。
- 已发布迁移不可改写；当前新生成迁移作为草稿审查。

## 验证

- `pnpm build`：构建框架、标准范例 API 和 Web。
- `pnpm test`：CLI、ESLint、PostgreSQL 内核和 HTTP 回归。
- `pnpm example:verify`：标准范例的类型、依赖、lint、图规则、生成一致性和数据库测试。
- `node packages/cli/bin/cage.js budget`：框架体积和公共词汇预算。
- 交付时分别报告通过、跳过和未执行的检查；不能把跳过当作通过。

## 发布资源

- `scripts/sync-template.mjs` 将标准范例的薄壳同步到模板，不复制框架实现。
- CLI 构建时把模板和错误码册打包，`create-cage-app` 仅调用 CLI。
- 本仓库远端为 `https://github.com/shunshunyue/cage.git`；没有可用提交基线时使用 `cage impact --base-file`。
- npm 包发布在 `@yss123` 名下，框架包使用 `@yss123/cage-*`，创建工具为 `@yss123/create-cage-app`。统一版本和发布步骤见 `docs/npm发布说明.md`。
- npm 发布会公开内容且不能覆盖同版本，必须在用户授权发布的范围内执行；不要擅自换发布账号或远端。
