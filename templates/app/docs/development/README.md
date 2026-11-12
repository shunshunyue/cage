# Cage 框架学习入口

本目录面向使用 Cage 编写业务的 agent，帮助 agent 理解需求、查证框架并完成真实实现。先读项目 AGENTS.md，再按 [cage-development Skill](skills/cage-development/SKILL.md) 工作；本页只负责按任务定位资料。教材由框架维护，随脚手架分发，读取无需额外服务、模型或向量索引。

工作主线：**理解需求 → 提出疑问与建议 → 核对现有业务和框架能力 → 说明实现映射 → 编码 → 按规则验收**。明确的规则直接采用，技术事实自行查证，需要用户决定的业务取舍再交给用户选择。

模型接入、智能助理和 AI 审批属于框架的原生 AI 能力，具体接入见[原生 AI 专题](guides/intelligence.md)。

## 按当前阶段阅读

| 你现在需要什么 | 从哪里开始 | 应得到什么 |
| --- | --- | --- |
| 第一次使用 Cage | [Skill 的运行模型](skills/cage-development/SKILL.md#先建立正确的运行模型) → [第一条完整业务链](getting-started/first-feature.md) | 理解声明、导出、生成、授权、契约与持久读写如何连接 |
| 用户描述或文档不清楚 | [业务澄清与共同设计](guides/business-collaboration.md) | 主动提出疑问、可行选项与建议，与用户选择业务规则，再落实到实现和验收 |
| 把需求转成设计 | [业务设计与能力选择](guides/recipes.md) → [编码前的映射](skills/cage-development/SKILL.md#4-写代码前说明实现映射) | 业务规则、查证过的能力、修改位置和验收例子一一对应 |
| 表达对象、状态和关系的业务含义 | [本体建模](guides/ontology-modeling.md) → [对象关系](guides/relations.md) | 名称写入真实声明，关系有正确方向、基数及执行依据，图谱能用业务用语阅读 |
| AI 生成 React 页面与选择组件 | [前端组件指南](guides/frontend-ui.md) → [路由](guides/routing.md) | 生成可维护的真实 TSX 页面，使用 Ant Design 组合 UI，并按 Cage 契约读写 |
| 实现或修改功能 | [Skill 的实施流程](skills/cage-development/SKILL.md#5-沿一条真实链路实施再扩展) → [开发步骤](getting-started/workflow.md) | 沿实际调用链完成受影响的功能，并取得验证证据 |
| 已有功能不正常 | [排错方法](tools/troubleshooting.md) → [诊断工具](tools/diagnostics.md) / [错误码册](../errors/README.md) | 找到第一个失败边界，修复原因并复验 |
| 查询一个能力的用法 | 下方专题表，必要时本地搜索术语 | 找到当前任务的 API、接入前提与限制 |

已经熟悉框架时不必每次重读课程。不要将所有专题一次加载，也不要把参考业务注册到客户应用。

## 各类文件的责任

| 文件 | 负责什么 |
| --- | --- |
| 项目 AGENTS.md | 项目入口、代码与环境约束；项目业务约定保留在框架托管区外 |
| [Skill](skills/cage-development/SKILL.md) | agent 的工作顺序、判断依据及何时与用户互动 |
| [业务澄清](guides/business-collaboration.md) | 如何发现疑点、比较方案、保留并落实用户选择 |
| [能力选择](guides/recipes.md) | 业务规则如何映射到 Cage，包含编码前的映射示例 |
| [本体建模](guides/ontology-modeling.md) | 业务含义、结构化名称、对象关系和触发链写在哪里，以及怎样检查和验收 |
| [开发步骤](getting-started/workflow.md) | 已确定设计的修改、生成、迁移和验证命令 |
| 其他专题、参考与源码 | 当前能力用法、前提与边界，按需阅读；示例业务不成为当前需求 |

## 按资料用途查找

| 目录 | 内容与入口 |
| --- | --- |
| `getting-started/` 入门 | [运行模型](getting-started/architecture.md)、[完整入门课](getting-started/first-feature.md)、[开发步骤](getting-started/workflow.md) |
| `guides/` 专题指南 | [业务澄清](guides/business-collaboration.md)、[能力选择](guides/recipes.md)、[本体建模](guides/ontology-modeling.md)、[前端组件](guides/frontend-ui.md)、[审批](guides/approvals.md)、[文件](guides/files.md)、[关系](guides/relations.md)、[路由](guides/routing.md)、[数据传输](guides/transfers.md)、[原生 AI](guides/intelligence.md) |
| `reference/` 参考规范 | [原语](reference/primitives.md)、[目录组织](reference/project-structure.md)、[中文注释](reference/commenting.md) |
| `tools/` 工具与排错 | [诊断](tools/diagnostics.md)、[本体上下文](tools/ontology-context.md)、[排错方法](tools/troubleshooting.md) |
| `examples/` 教学示例 | [便笺源码](examples/note/note.ts)、[采购导读](examples/purchase-example.md)；按入门课与导读阅读，源码不自动注册 |
| `skills/` agent 开发流程 | [cage-development](skills/cage-development/SKILL.md)，按任务加载上述教材 |

查明确符号可用 `rg -n "术语或符号" docs/development docs/errors`，没有 rg 时使用 agent 的本地文件搜索。用 `pnpm exec cage capabilities 符号 --format json` 核对已安装版本公开签名，用 `pnpm exec cage context "业务关键词" --format json` 定位当前应用。候选命中不能代替阅读上下文，未命中也不能证明框架不支持。

## 确认代码与资料的位置

本指南的业务路径和命令默认相对应用根目录。应用的 `packages/domain/src` 定义业务，`packages/contracts/src` 是生成契约，`apps/web/src` 是界面，`apps/api/src` 是薄启动入口，`db/migrations` 保存审查过的迁移。

空白模板只启用组织基础；`docs/examples/purchase-admin` 是离线采购参考源码，不参与注册、编译或迁移。采购模板直接在业务目录包含该范例。框架仓库的应用根目录是 `examples/purchase-admin`，规范教材位于仓库 `docs/development`，以应用 AGENTS.md 的说明为准。

`docs/development` 是框架教学内容的唯一手写来源；Skills 发现入口和模板副本由同步脚本生成。用户的业务约定保留在项目已有业务文档或 AGENTS.md 的托管区外。教材分发检查只能证明资料存在且一致，模型是否学会需要框架维护者另做任务评估。

## 当前实现边界

以下区分可避免 agent 把方案中的愿景写成不存在的功能。

| 已有能力 | 使用边界 |
| --- | --- |
| 真实 PostgreSQL 连接、分账号、表结构迁移 | 连接已有数据库；`init` 不建库；不会自动识别并接管任意历史表 |
| 聚合/命令、能力与范围、掩码、审计、outbox、worker | handler 不做数据库/网络 IO；生产角色不会自动拿到新能力 |
| fields 中的 ref / hasMany / manyToMany | hasMany 为只读反查；manyToMany 自动中间表并随主对象事务写入，公开读取独立分页；双向集合不会自动互为镜像 |
| 本体抽取、中文检索/节点/路径/AI 上下文、图规则、图谱、生成、影响分析与门禁 | 上下文注明证据、源码和覆盖边界；名称与测试匹配是候选线索，不能证明任意 JS 正确；跳过用例仍需补足 |
| 有界集合 reactionEach、显式步骤 order | 稳定唯一键排序后串行调用目标命令；同事务整体回滚，异步链按 outbox 恢复；不是并行写表接口 |
| capabilities、doctor、timeline、explain、snapshot | 实际运行诊断需要受控会话与权限；未取得的证据为 unknown，授权解释不执行 handler |
| 代码审批路由与任务流转 | 顺序/条件、`parallel/branch` 结构化 AND 分支与汇合、any/all、字段选人、候选领取/释放、转办、单层委派归还、前后/并行必签和动作历史；候选池仅支持 any，追加票全部必签。条件和依赖随提交冻结，currentStep 仅为最小活动索引；尚无任意连线/循环/OR 网关、岗位/代理规则、通用恢复、任意 JS 选人或在途迁移，见[任务流转](guides/approvals.md) |
| 审批时限、站内提醒与催办 | 人工节点按实际开启时间计算自然分钟 SLA，worker 持久投递临期/超时提醒；申请人可按完整活动集合催办，同实例共享冷却，接收人可标已读。旧快照不自动获得政策；尚无工作日历、自动升级、抄送或邮件/短信通知 |
| 审批界面与 SDK | Admin/采购待办可领取、释放、归还受托任务并查看等待加签；采购另有协作名录选人器、转办/委派/三种加签及分页人工历史，view 查询参数保留视图。启用运营后通用 Admin 提供我的申请、催办和流程提醒；页面仍需应用启用、真实授权与浏览器验收。AI 助理目前只查询本人待办及提交决定，无人员管理写工具 |
| 原生 AI 审批与领域助理 | 现有 `step` 支持 `kind: 'ai'`；三态审核、自动工具、会话及偏好记忆可复用；需显式启用、授权并做模型质量验收 |
| Admin 模型与性格、助理 SDK | 动态模型连接和性格管理；Chat Completions / Responses 兼容性以实际服务为准；SDK 提供流式状态与页面快照，悬浮窗和 Markdown 由应用实现 |
| 连接器 fake、出站、入站验签、同步记录 | fake 不等于真实 ERP 联调，也不等于完整请求录制/回放平台 |
| 异步 CSV 导入/导出接口与客户端任务查询 | 界面由业务项目决定；导出结果不是可直接回导的命令输入模板 |
| 私有文件字段、流式分片上传、暂停与续传、范围下载 | 默认本地存储，提供对象存储适配接口；尚无内置 S3/OSS、签名直传、病毒扫描及文件共享 |
| 组织模型、系统管理界面 | 暂无移动部门（改上级）的完整支持、菜单配置页 |
| 库存锁采购范例 | 演示资源生命周期；不是仓库级并发库存扣减、退货或 ERP 撤销补偿系统 |

文档与实现冲突时，以当前代码和检查结果为依据，指出冲突并修正文档；不要默默扩展公开 API。规划、代码存在、构建通过、真实联调通过是不同状态，交付时分别说明。
