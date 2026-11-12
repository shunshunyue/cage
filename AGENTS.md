# Cage 框架维护约定

本仓库实现框架本身，使用 TypeScript、pnpm workspace、Node.js 24 和 PostgreSQL。业务范例为 examples/purchase-admin，采购分发模板为 templates/app，空白模板为 templates/blank。进入应用目录还要读其 AGENTS.md。

## 按任务进入

| 任务 | 先读 |
| --- | --- |
| 维护框架、CLI、范例分发 | [框架维护](docs/maintainers/framework-development.md)，按其包边界修改 |
| 编写或修改业务 | [开发 Skill](docs/development/skills/cage-development/SKILL.md)，按本次任务加载教材 |
| 第一次了解运行机制 | [执行模型](docs/development/getting-started/architecture.md)与[便笺课程](docs/development/getting-started/first-feature.md) |
| 不清楚业务含义 | [业务协作](docs/development/guides/business-collaboration.md)；技术事实由 agent 查证，业务取舍由用户决定 |
| 查参数、实现或故障 | [原语](docs/development/reference/primitives.md)、[本体工具](docs/development/tools/ontology-context.md)、[诊断](docs/development/tools/diagnostics.md)、[错误码册](docs/errors/README.md) |

已明确的规则与授权直接沿用。写业务代码前简述规则、已查证的能力、修改位置与验收；普通技术方案无需额外批准。规划不能当作现有 API，有疑问核对包 src/index.ts、声明实现和生成契约。

## 必须保持的边界

- 智能体并发最多 2：主智能体之外最多 1 个；需要更多分工时顺序执行。
- 所有手写源码遵守[详细中文注释](docs/development/reference/commenting.md)。文件头、导出 API/类型字段、关键流程与复杂分支解释做什么、为什么、如何完成及实际边界；新建同步写，修改同步核对上下游。仅注释任务保持逻辑、接口、配置值和运行文案不变。
- 注释按实际单位、空值、状态、权限、事务、并发、幂等、重试、缓存和清理说明保证；不以机械逐行翻译、模板或字数代替解释。生成物注释从生成器维护，已发布迁移不改写。
- 内核保持业务无关。修改内核说明必要性，以有意义回归证明行为，发布前由架构负责人评审。普通业务写入走命令，读取走安全视图，外呼走连接器。
- handler 的读依赖写入 reads，job 的读与命令写入 reads/calls；声明沿模块入口导出到 domain。前端只依赖契约、client 和协议，不导入 domain、数据库或内核运行时。
- domain 按 modules/workflows/integrations/shared、Web 按 app/modules/shared 组织，遵守[目录规范](docs/development/reference/project-structure.md)。contracts 由生成器按聚合维护根公共入口；两模板保持 structure: modular。
- 多页面使用 React Router，列表/详情有 URL，筛选和分页进入查询参数；app 组合模块入口。导航变更实际验收深链接、刷新、前进后退、登录回跳、无权限和 404，见[路由指南](docs/development/guides/routing.md)。
- 新能力不自动授给普通生产角色。前端 can() 只控制显示，审批选人不授予权限；服务端判断实际能力、范围和约束。
- 领域含义变化前保存本体基线；改声明后检查与生成，审查契约和迁移草稿。范例执行 pnpm --filter @app/purchase-admin gen；生成物不手改，已执行/发布迁移保留，新结构用新迁移。
- .env、Cookie 密钥、数据库密码与初始凭据不进入源码/文档。诊断连接只输出主机、端口、库名和错误码。项目已有 PostgreSQL，普通业务不新建连接池或管理 Docker。
- 维护脚本使用 .ts，不新增 .mjs。不增加没有业务价值的防御分支或静默兜底。

## 框架可选能力

原生 AI 由 domain 导出 ai() 启用，AI 审批使用 step 的 kind: 'ai'。运行时提供工具、会话、记忆与流式协议，应用提供策略、授权、上下文和界面；具体见[原生 AI](docs/development/guides/intelligence.md)。

增加框架能力时，同时更新 CLI sync.ts 托管指引、capabilities.ts 检索提示、当前教材及模板，分别核对框架支持、应用启用与实际执行。

## 修改与验证

修改前说明本次确定的规则、实现依据、最小位置与可观察结果。文档或可逆小改动按影响验证，不重复全量数据库回归。

| 根目录命令 | 范围 |
| --- | --- |
| pnpm install / pnpm build | 依赖与框架、范例 API/Web 构建 |
| pnpm test | CLI、lint、PostgreSQL 内核与 HTTP 回归 |
| pnpm example:verify | 范例类型、依赖、lint、图、生成与数据库 |
| node packages/cli/bin/cage.js budget | 内核体积、词汇和 unsafe |
| pnpm docs:check / pnpm docs:examples | 资料链接/分发与教学源码 |
| pnpm typecheck:scripts | 维护脚本类型 |

范例目录使用 pnpm exec cage check、pnpm gen；业务图谱用 cage graph。交付分别报告通过、跳过和未执行，保持完整诊断 code/at/reason/fix。修复根因，不以放宽权限、删约束、禁用 lint 或改写历史消除错误。

## 文档、模板和发布

docs/development 是当前教材唯一手写来源；Skill 唯一正文位于其 skills/cage-development/SKILL.md。scripts/sync-agent-skill.ts 生成发现入口，scripts/error-catalog.ts 经 docs:errors 生成错误册，scripts/sync-template.ts 分发教材和两套模板共享配置。

采购模板从范例同步；空白领域、页面及初始迁移独立维护，采购参考源码仅阅读。AGENTS 框架区由 CLI sync 托管，客户约定放标记外。模板 _gitignore 创建后恢复 .gitignore，分发阶段保留占位名。

指南或错误码变化运行文档检查，课程变化运行 docs:examples；托管区变化先同步范例，再同步模板并构建 CLI。客户应只靠分发的本地教材学习，不要求另克隆框架。

远端为 https://github.com/shunshunyue/cage.git，没有 Git 基线用 cage impact --base-file；不擅自创建或推送远端。公开包在 @yss123，统一版本与发布按[npm 发布说明](docs/maintainers/npm发布说明.md)，只在用户授权范围内执行且不覆盖已发版本。
