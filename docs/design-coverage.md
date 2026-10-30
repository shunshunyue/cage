# 设计实现对照表

核对日期：2026-10-29。依据：[技术架构与实施方案 v0.1](../AI%20中后台框架：技术架构与实施方案（v0.1）.md)、当前源代码和已有验收记录。

2026-10-30 发布补充：已建立 Git 仓库并上传到 `shunshunyue/cage`，十个 `0.1.0` 包已发布到 `@yss123`，采用 MIT，且已通过普通 npm 入口创建、安装和构建项目。增加了打包检查、仓库外安装验证及手动触发的 npm 发布工作流。下表中未建仓库/未发布 npm 的条目描述核对当日状态；框架包发布不代表生产应用部署流水线已经完成。具体结果见 [发布记录](release-0.1.0.md)，操作步骤见 [npm 发布说明](npm发布说明.md)。

**结论：主要开发链路已经可用，不能认定整份设计文档全部完成，也不能认定已经完成生产验收。** 特别是阶段 0 的两个独立范例、对照实验等验收条件，仍未全部满足。

本次是源码和资料核对，没有执行新一轮构建、数据库测试、浏览器验收或部署。下表的“已有验证”引用 [实施与验收记录](implementation-status.md)，不代表本次重新验证，也不是逐行安全审计。

## 1. 按设计章节对照

| 设计章节 | 当前状态 | 已有内容与具体边界 | 主要依据 |
| --- | --- | --- | --- |
| §3–4 技术栈与仓库 | 已实现主要结构 | TypeScript、pnpm workspace、框架包、范例、模板；当前主目录未建立 Git 历史及远端 | [根配置](../package.json)、[框架包](../packages) |
| §5 声明与内核 | 已实现主要能力，有数据库回归 | 15 组原语、注册表、能力目录、写入流水线、乐观锁、幂等、审计、outbox、同事务反应、批量执行；不能由通过数量推断所有组合路径已覆盖 | [kernel](../packages/kernel/src/kernel.ts) |
| §6 数据库与安全读侧 | 已实现主要能力，有真实 PostgreSQL 验证 | 角色初始化、连接池、业务表、安全视图、行级策略、掩码、迁移；本地 Docker PostgreSQL 18 持久化已验证 | [数据库模块](../packages/kernel/src/db)、[本地接入记录](local-postgres.md) |
| §6.5 迁移差异 | 存在设计差异 | 当前比较迁移文件尾部的结构快照；不是用临时数据库重放历史后计算差异。已执行迁移有校验和保护 | [生成器](../packages/cli/src/gen/index.ts)、[迁移器](../packages/kernel/src/db/migrate.ts) |
| §7 HTTP、SDK、前端 | 已实现主要能力，导出部分完成 | 路由、OpenAPI、会话、CSRF、限流、契约、SDK、hooks、React 工作台；CSV 导出同步返回，未实现设计要求的异步文件导出 | [HTTP 路由](../packages/http/src/routes.ts)、[契约生成](../packages/cli/src/gen/contracts.ts)、[前端](../examples/purchase-admin/apps/web/src/main.tsx) |
| §8 组织权限与管理 | 部分完成 | 部门/用户/角色、能力授权、范围、防提权、审计、死信与任务页面可用；部门移动、菜单配置页未实现；指定部门集合等内核能力也未全部做成管理页操作 | [admin](../packages/admin/src)、[管理页面](../packages/admin/ui/app.js) |
| §8.1 SSO | 协议代码已实现，真实对接待验收 | 有 OIDC 接入和用户映射；尚无公司身份源与完整组织同步的部署验收。不能把本地账号登录验收视为 SSO 验收 | [OIDC](../packages/http/src/oidc.ts) |
| §9.1–9.4 异步运行时 | 已实现主要能力，有数据库回归 | worker、outbox、重试、死信、清理、同事务反应、定时任务及调度锁；生产吞吐、积压和故障恢复需验收 | [worker](../packages/kernel/src/worker) |
| §9.5 连接器 | 运行时及 fake 可用，真实交付未完成 | 地址/字段白名单、密钥入口、限流、超时、同步记录、验签及映射；ERP 仍为示例地址和 fake，真实沙箱/生产对接与录制回放样例未交付 | [连接器运行时](../packages/connectors/src/runtime.ts)、[范例 ERP](../examples/purchase-admin/packages/domain/src/erp.ts) |
| §9.6 审批 | 代码内审批可用，外部引擎待接入 | 适配接口、桥接、步骤/分支、选人、待办、职责分离及额度；真实外部审批引擎尚未对接验收 | [approval](../packages/approval/src) |
| §10.1–10.2 命令与抽取器 | 已实现 | 静态声明检查、加载注册表、本体图抽取；额外提供中文 Web 图谱、字段卡片与关系解释 | [CLI 入口](../packages/cli/src/main.ts)、[分析流程](../packages/cli/src/analyze.ts)、[图谱服务](../packages/cli/src/graph.ts) |
| §10.3–10.4 影响与图规则 | 已实现主要能力，有工具链测试 | 文件/Git 基线、影响传播、状态与资源配对等检查；真实项目中的影响召回率尚未通过对照实验衡量 | [影响分析](../packages/cli/src/impact.ts)、[图规则](../packages/cli/src/rules.ts) |
| §10.5 派生测试 | 部分完成 | 能力、状态、范围、审计、幂等、掩码、不变量用例生成；目前范围生成主要覆盖 self/dept，未实现每个硬约束的通用反例生成；不变量序列使用简单随机选择，尚未按设计接入 fast-check 的命令序列及失败缩减。范例另有定向约束用例 | [生成器](../packages/cli/src/derive.ts)、[派生测试运行时](../packages/testkit/src/derived.ts) |
| §10.6、§11.1 门禁 | 已实现，有本地验证 | 依赖规则、ESLint、verify 汇总及报告、预算；测试跳过会单独记录，不能把报告的完整执行状态理解为完整覆盖 | [lint](../packages/lint)、[verify](../packages/cli/src/verify.ts) |
| §11.2 CI | 配置已写，远端执行待验收 | 框架 CI、可复用业务 CI、模板 CI、PR 影响摘要、依赖审计、报告归档；Linux/GitHub Actions 未实跑验收 | [工作流](../.github/workflows) |
| §11.3 发布流水线 | 部分资源已写，完整流水线未实现 | 已有 Dockerfile；尚无完整的镜像发布、预发布迁移与冒烟、生产确认与滚动部署、回滚演练链路，应用镜像构建也未验收 | [根 Dockerfile](../Dockerfile)、[模板 Dockerfile](../templates/app/Dockerfile) |
| §12 AI 协作、范例、错误码 | 部分完成 | AGENTS 托管区、错误码册、采购综合范例和模板可用；还缺第二个独立标准范例、真实外部样例录制/回放及使用效果实验 | [AGENTS](../AGENTS.md)、[错误码](errors/README.md)、[采购范例](../examples/purchase-admin) |
| §13 新建与开发流程 | 本地源码方式可用 | `create`、数据库 CLI、`dev`、生成、迁移、图谱；npm 包未发布，当前新项目依赖本地框架 `link:` | [脚手架](../packages/cli/src/create.ts)、[使用说明](使用说明.md) |
| §14 升级维护 | 最小流程已实现 | 当前只支持 0.1.0 目标和 `caller` → `invokedBy` codemod；sync 只更新 AGENTS 托管区；Renovate 配置已有，跨实际已发布版本的升级链尚未验收 | [升级](../packages/cli/src/upgrade.ts)、[同步](../packages/cli/src/sync.ts)、[Renovate](../renovate.json) |
| §15.1、15.4 可观测 | 部分完成 | 有 OTel API 包装、部分内核 span、outbox 上下文传播、日志与审计；未覆盖 HTTP/每关流水线/数据库/连接器的完整追踪，没有交付指标采集、exporter、仪表盘和告警体系 | [telemetry](../packages/kernel/src/telemetry.ts)、[kernel](../packages/kernel/src/kernel.ts)、[日志](../packages/http/src/logger.ts) |
| §15.2–15.3、15.5 安全基线 | 应用层主要能力已做，部署层未交付 | 已有 HTTP 防护、输入校验、最小权限、掩码和日志打码。默认密钥读取环境变量，有 SecretProvider 扩展，但没有真实密钥服务接入；出站代理未强制部署；每日备份、WAL 归档与恢复演练未交付 | [HTTP 服务](../packages/http/src/server.ts)、[连接器](../packages/connectors/src/runtime.ts)、[数据库模块](../packages/kernel/src/db) |
| §16 实施验收 | 尚未全部达成 | 核心及多项后续阶段能力已有实现；阶段 0 的两个独立范例、五轮对照实验和完整覆盖验收仍缺，首个真实业务上线尚未完成 | [现有验收记录](implementation-status.md) |
| §16.2 导入、§17 性能风险 | 基础能力可用，产品入口/验收未完成 | `executeBatch` 已实现；文件上传解析、导入任务与结果页面尚未交付。安全视图执行计划、同事务反应高并发与生产压测尚无验收基线 | [批量执行](../packages/kernel/src/kernel.ts)、[HTTP 路由](../packages/http/src/routes.ts) |

## 2. 对“是否做完”的具体回答

### 已经可以直接用

- 真实 PostgreSQL 上的命令写入、安全读取、权限、审批、审计、异步处理与第三方 fake 流程。
- `cage` 命令链：创建、开发、检查、生成、抽取、影响分析、测试、门禁、预算、同步、迁移及最小升级流程。
- 采购工作台、系统管理、中文图谱；图谱可以查看对象字段及连线原因。
- 本地创建独立业务项目，复用框架包，不复制框架实现。

### 仍需补实现

- 异步文件导出；文件导入完整入口；部门移动、菜单配置及管理页未覆盖的配置能力。
- 完整追踪与指标体系；真实密钥服务、强制出口代理和备份恢复设施。
- 完整发布流水线；真实第三方样例录制与回放；第二个独立范例。
- 派生测试的通用约束反例、范围组合及性质测试能力；现有跳过用例的合法前置数据。
- 若要将采购范例作为正式业务系统，还需按实际需求补齐库存核算、ERP 撤单、退货和补偿。

### 仍需真实环境验收或产品决策

- 公司 SSO、外部审批引擎（如选用）、真实 ERP 沙箱/生产接口。
- 应用镜像、Linux CI、预发布与生产部署、故障恢复、性能基线。
- 五轮有/无框架对照实验，形成缺陷、评审时长、影响召回率与一次通过率报告。
- §18 中的业务选型仍需明确记录。代码当前采用 PostgreSQL、Fastify、React 和代码内审批；虽然有 tenant 上下文字段，本地账号登录与 OIDC 使用默认租户，不能据此认定多租户产品入口、租户生命周期和隔离验收已完成。

迁移的“结构快照比对”属于与设计不同的实现，需要明确接受差异，或后续改为临时库比对；不应在文档里直接写成原设计已实现。当前测试通过独立 Docker PostgreSQL 或 embedded-postgres 运行，未使用设计举例中的 Testcontainers，但都使用真实数据库。

## 3. 已有验证与本次核对的边界

| 分类 | 记录 |
| --- | --- |
| 以前通过 | 框架构建/类型检查；88 个框架测试，其中数据库 42、CLI 36、ESLint 10；采购范例 verify 91 个测试通过；本机真实数据库持久化与浏览器流程；预算检查 |
| 以前跳过 | 采购范例通用派生测试 10 个；详见 [验收记录](implementation-status.md)，不计为通过 |
| 本次完成 | 设计章节、源码入口、CLI 参数、配置和产物路径的文档核对 |
| 本次未执行 | build、test、verify、budget、浏览器操作、镜像构建、远端 CI 和生产部署 |

建议后续优先确认首个真实业务的需求，再补对应功能与外部对接，最后做发布和运维验收。当前可以开始业务试用，但不以“所有设计已完成”为交付结论。
