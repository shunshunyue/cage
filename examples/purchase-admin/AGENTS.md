# 标准业务范例说明

当前目录是 Cage 框架仓库中的可运行采购范例；业务源码均相对本目录。框架通过 workspace 依赖引用，不在业务目录复制实现。

本范例使用框架仓库中的规范资料：[业务开发入口](../../docs/development/README.md)、[采购全链路](../../docs/development/examples/purchase-example.md)、[错误码册](../../docs/errors/README.md)。下面托管区提到的 `docs/development`、`docs/errors` 在本源码范例中分别指 `../../docs/development`、`../../docs/errors`；创建的独立项目会自带这两个目录。

范例用于演示模式；客户业务应按实际需求新增/替换 domain 和页面，不固定为采购。库存锁演示不包含仓库级并发扣减或真实 ERP 取消补偿。

目录与依赖遵守[工程组织规范](../../docs/development/reference/project-structure.md)：业务在 modules 内集中，前端 app 负责组合，跨领域模块反应在 workflows，第三方在 integrations。不要把业务重新平铺到 src 根目录。

<!-- cage:begin v0.3.2 -->
## Cage 业务开发约定（框架托管）

### 学习与任务入口

本项目使用 `@yss123/cage-*`，业务写在本项目。先读项目说明指定的教材；独立项目默认入口是 `docs/development/README.md`。

开始 Cage 业务开发或排错时，加载 `docs/development/skills/cage-development/SKILL.md`。它讲清运行模型、业务澄清、能力选择、实施与验收方法；首次学习配合 `docs/development/getting-started/first-feature.md`。已熟悉时只读受影响专题，普通样式/文案改动无需重走业务建模。

支持 Agent Skills 的工具可发现 `.agents/skills/cage-development`；其他工具直接读取上述 Markdown，使用相同流程。教材随框架版本分发，均为本地文件，不需要额外服务、模型或索引。框架仓库范例使用项目说明指定的规范教材位置。

### 框架执行什么

- 业务声明从 domain 总入口导出，框架据此构建注册表、能力、HTTP 接口、本体图、契约与迁移草稿；只有文件而未导出不会生效。
- 命令是业务写入口；handler 描述变化与显式 reads，内核处理授权、状态、范围、版本、事务、审计及 outbox。读侧通过生成契约或 query 的安全视图，外部 IO 通过连接器。
- 角色、能力、数据范围、调用身份与业务约束分别建模。前端 can() 只影响显示，新增能力不自动授给生产角色；审批选人不授予能力。
- 页面依赖生成契约及客户端。表单、弹窗等临时状态留在前端；正式业务数据和流程结果通过服务端读写。实际记录不能用模拟仓储或固定统计替代。

### 实现与排错

1. 阅读需求、文档和现有实现后，按 `docs/development/guides/business-collaboration.md` 主动提出疑点、可行选项、影响与推荐理由，让用户选择业务规则；沿用已明确的选择与授权，等待回答时推进独立部分，可选建议不阻塞已明确任务。再把确定的规则映射到聚合、命令、归属/范围、后续行为与验收，沿已有模块修改。具体选择看 `docs/development/guides/recipes.md`，目录归属看 `docs/development/reference/project-structure.md`。
2. 不熟悉的 API 先按手册任务目录定位，用本地文件搜索查术语，再执行 `pnpm exec cage capabilities 符号 --format json` 核对当前版本签名；`cage context "业务关键词"` 定位当前应用。未命中不代表不支持，不发明方法或返回字段。
3. 涉及已有领域含义变化，先 `pnpm exec cage snapshot save before-change` 保存本体基线，或使用真实 Git 基线。修改声明与导出，运行 check/gen，审查契约和迁移草稿。生成物不手改，已执行迁移不可改写。
4. 页面使用真实契约，处理业务失败、版本冲突、会话与缓存；多页面使用独立 URL，列表筛选/分页进入查询参数。按 `docs/development/guides/routing.md` 验收深链接、刷新、登录回跳和无权限行为。
5. 出错保留 code/at/reason/fix，查 `docs/errors/README.md` 与 `docs/development/tools/troubleshooting.md`；从真实调用逐层定位。不得放宽权限、删约束或关闭门禁来掩盖问题。

遇到原生 AI、AI 审批或随页助理，先读 `docs/development/guides/intelligence.md`，核对已有能力及应用启用状态。审批、文件、关系、数据传输等专题由 Skill 按需引导，不重建框架已有运行时。

### 代码与环境边界

- 所有手写代码遵守 `docs/development/reference/commenting.md`：文件职责与调用链、导出 API/字段、复杂分支的中文说明，写清做什么、为什么、怎样完成及实际边界；随代码更新。生成物注释从生成器维护。
- domain 按 modules/workflows/integrations/shared 组织，Web 按 app/modules/shared 组织。模块通过 index.ts 公开入口组合，前端不导入 domain、数据库或内核运行时；不关闭 modular 目录门禁。
- 新项目启动步骤见 `docs/development/getting-started/workflow.md`。使用已有 PostgreSQL 和项目 .env；init 准备账号，migrate 更新结构，bootstrap 显式初始化组织，dev 启动进程。普通业务不新增连接池或管理 Docker。
- 不输出或提交 .env、数据库密码、Cookie 密钥及初始化凭据。API 与 worker 使用一致的 domain，修改配置后按实际需要重启。

### 完成依据

验证与改动匹配。check/gen/typecheck/build 证明各自检查范围；业务读写还需独立读取结果，权限需直接请求验证，审批需待办与结论，文件需实际内容，异步需任务终态，页面需浏览器操作。

`pnpm verify` 汇总门禁；`verify --skip-tests` 不代表完整通过。诊断用 `cage doctor`、`timeline`、`explain`，具体前提见 `docs/development/tools/diagnostics.md`。交付分别说明通过、跳过、未执行及剩余配置；文档和可逆小改动不反复执行全量数据库回归。
<!-- cage:end -->

