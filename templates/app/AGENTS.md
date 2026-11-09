# 本项目的业务开发说明

这是 create-cage-app 生成的业务项目，当前包含采购演示，可逐步替换成客户业务。业务源码在本项目，框架通过 @yss123/cage-* 依赖提供。

先读 [业务开发指南](docs/ai/README.md)，按需求查 [任务配方](docs/ai/recipes.md)、[完整采购范例](docs/ai/purchase-example.md) 和 [错误码册](docs/errors/README.md)。这些资料就在项目内，无需克隆框架仓库。

## 项目自己的业务约定

客户术语、角色权限、状态规则、第三方协议和验收标准写在本节或独立业务文档，再从这里链接。新增业务以用户需求为准，不因模板包含采购示例就固定实现采购流程。

本节位于托管区之外，cage sync 会保留。下面的托管区提供框架工作方法。

<!-- cage:begin v0.3.0 -->
## Cage 业务开发约定（框架托管）

### 先读，再按需求改业务

本项目由 create-cage-app 创建。框架来自 `@yss123/cage-*` 依赖，业务写在本项目；不需要克隆框架仓库，也不要复制框架内部实现。

先读项目说明指定的学习资料，默认入口为 `docs/ai/README.md`。第一次读 `architecture.md`、`project-structure.md` 和 `primitives.md`；具体任务读 `recipes.md`，采购全链路读 `purchase-example.md`，错误查 `docs/errors/README.md` 和 `docs/ai/troubleshooting.md`。资料相对该学习目录，项目说明可指定源码仓库中的规范资料位置。

### 详细中文注释（每次开发必须遵守）

所有新增和维护的手写源码都必须写详细中文注释，先读学习目录中的 `commenting.md`（独立项目为 `docs/ai/commenting.md`）。注释是交付内容，不能以“代码自解释”或“保持简洁”为由省略。

- 每个文件开头说明模块职责、谁调用它、主要调用链和责任边界；纯导出入口也说明如何组合模块。
- 导出函数、类、组件、hooks、接口和业务声明使用 JSDoc，写清用途、参数含义、返回结果、主要步骤、前置条件、失败行为和副作用；复杂内部函数同样说明。参数类型已表达的语法无需重复，业务单位、空值、默认行为与约束必须解释。
- 领域代码说明字段和状态的业务意义、命令调用身份与权限/范围、reads 依赖、事件用途、事务与异步边界、幂等/重试及资源释放；只写实际声明和实现已有的保证。
- 页面说明 URL/查询参数、数据来源、临时状态、加载/空态/失败/无权限、提交后的刷新、会话与订阅清理；复杂分支、计算、顺序、并发和缓存规则在附近解释原因与过程。
- 测试说明场景、前置条件、动作、断言和所防止的回归；脚本说明输入、读写路径、执行顺序、外部副作用与退出条件。注释不含密钥、凭据或个人数据。
- 注释同时回答“做什么、为什么、如何完成、有哪些边界”，不能只有一句标题，也不能机械逐行翻译、凑字数或批量粘贴空泛模板。代码变更时同步更新注释，交付前逐文件核对。
- 生成契约的注释由生成器维护，不手改生成物；已执行/已发布迁移不能改写。仅补注释时不得顺便重构或改变逻辑、接口、配置值和运行文案。

### 原生 AI 能力入口

遇到以下需求，先读 `docs/ai/intelligence.md`，用 `pnpm exec cage capabilities "关键词" --format json` 核对当前安装版本的公开 API，再检查本项目 domain 导出和页面接入。关键词可直接使用下表需求名称；未命中时缩短关键词或查公开符号，不能据此断言能力不存在。

| 需求 | 框架入口与应用职责 |
| --- | --- |
| AI审批 / 智能审批 | 现有 `step` 使用 `kind: 'ai'`，支持 pass 通过、return 退回修改、manual 转人工；应用声明策略、结论命令、自动执行角色及接管人 |
| 业务助理 / 本体助理 | 导出 `ai({ models, assistant })`；框架提供执行循环、按领域声明生成的工具、会话、偏好记忆和 HTTP；应用配置授权及界面 |
| 页面上下文 / 随页助理 | `useAssistant(client.ai, page)` 配合 `useAiPageContext` / `AiPageContext`；应用上报页面、对象、选中项和草稿，服务端重读并校验业务事实 |
| 模型管理 / Responses | `managedModel` 接入 Admin 动态配置，支持 Chat Completions / Responses；应用配置部署加密密钥并显式授权管理者 |
| 性格 / 流式输出 | Admin 管理性格，SDK 提供选择、增量文字与执行进度；应用实现悬浮窗、Markdown 和确认卡片 |
| 上下文预算 | `ai({ context: ... })` 的配置形状见 `AiContextOptions`；框架按预算选择完整工具或发现模式，历史和本体按需读取 |

前端只使用客户端、协议与契约；后端循环、通用工具和记忆使用框架实现。页面快照和性格不授予权限。分别核对**框架支持**（公开导出）、**项目已启用**（domain 导出、迁移、模型、权限、worker、SDK）和**实际验证通过**（真实角色与模型联调）；空白模板的参考代码不表示已启用。具体接入顺序和验收步骤见该指南，不必将整份指南塞入每次任务上下文。

### 业务代码放在哪里

| 位置 | 职责 |
| --- | --- |
| `packages/domain/src/modules/<业务>` | 同业务聚合、状态、命令、事件、审批、查询、任务；模块 index.ts 公开导出 |
| `packages/domain/src/workflows`、`integrations` | 跨模块反应 / 第三方协议与映射；不堆到全局 reactions.ts、queries.ts |
| `packages/domain/src/index.ts` | 统一导出全部业务及组织模型；没导出的声明不会注册 |
| `packages/contracts/src/aggregates/<聚合>`、`queries` | 生成协议；根 index.ts 提供 @app/contracts 公共入口，只用 cage gen 更新 |
| `apps/api/src` | API/worker 薄启动入口，普通业务不手写 HTTP 路由 |
| `apps/web/src/app` | 会话、URL 路由、布局、模块组合；main.tsx 只挂载和装配 Provider |
| `apps/web/src/modules/<业务>` | 页面、表单、专用 hooks/API/样式；从模块 index.ts 暴露页面 |
| `apps/web/src/shared` | 跨模块复用且不绑定业务的 UI、hooks、纯辅助函数 |
| `db/migrations` | 审查过的结构迁移，作用于已配置的数据库 |
| `cage.config.json` | 项目路径、检查配置、graph.labels 中文图谱名称 |
| `.env` | 本机真实连接和密钥；不提交、不输出完整内容 |

新增业务不得继续平铺在 src 根目录。前端模块只依赖自己和 shared，由 app 通过公开入口组合；shared 不反向依赖业务。领域模块间确有读取依赖时走目标模块 index.ts；跨模块反应写 workflows。小模块不创建空层级，已有独立职责再拆文件。完整命名、目录树和示例见 `docs/ai/project-structure.md`。新模板启用 `structure: modular`，check/verify 检查目录和导入边界，遇到 CAGE-STRUCT 错误按职责修正。

### 实现一项需求的顺序

1. 先运行 `pnpm exec cage context "需求关键词"`；按需 `graph search` 查候选、`graph inspect` 查完整节点、`graph path` 看关系路径。确认中文匹配入口后按源码位置阅读实现；候选和子图不是全部依赖，具体条件不能凭连线推断。完整用法见 `docs/ai/ontology-context.md`。从用户需求确定字段、状态/动作、角色/范围、约束与后续动作；能由业务声明表达的不改框架。
2. 已有业务含义变化时，修改前用 `pnpm exec cage snapshot save before-change` 保存不可覆盖的命名基线；或使用真实 Git 提交/独立本体图文件。
3. 先声明 aggregate/states/command/constraints/event，再写 handler、reaction/query/approval/connector，最后接业务页面。声明使用模块顶层 `export const`，从 domain 入口导出，跨文件导出名保持唯一。
4. 运行 `pnpm exec cage check` 和 `pnpm gen`，审查 contracts 和迁移草稿。按需运行 `pnpm exec cage impact --snapshot before-change`，补中文图谱名。
5. 页面使用生成方法并处理 code/domainCode；列表、详情等多页面注册到 React Router，Link/NavLink 导航，筛选/分页进入 URL。组件状态用于弹窗和表单等临时交互。新增能力由管理员授权。数据库结构变化审查后显式 `pnpm migrate`，dev 不代办迁移。
6. 按 `commenting.md` 逐文件检查详细中文注释与实现一致，再按改动运行必要验证；交付时说明体验步骤、授权配置、迁移、注释覆盖，以及通过/跳过/未执行项。

### 必守边界

- 聚合定义对象字段、状态、范围字段与不变量；命令是业务写入口。handler 只计算业务变化和读取 reads 中的依赖，不直接操作数据库、网络或文件。
- 对象关系统一放在 fields：ref 为外键，hasMany 为只读反查，manyToMany 自动生成中间表并随所属对象命令提交。前端用生成的 related 方法分页读取；不手写纯中间表聚合，不把单页结果当完整集合替换。完整例子见 docs/ai/relations.md。
- command 的 input 使用 Zod；已有记录输入必须含 id。from/to 表达状态迁移；`to: null` 只适用于已有记录并保留状态，不能靠 handler 改 status 绕过状态机。
- 写入、审计、版本、幂等和事务交给内核；不要在业务项目重建 repository、连接池或权限流水线。
- 自定义查询声明 reads，二选一使用 sql/build，只读 `safe.*`；值参数化。不得拼接 SQL、查询基表绕过范围或硬编码密钥。
- scope 描述范围字段，角色数据决定实际范围；`scope.none()` 不代表所有人可访问。`can/useCan` 只控制按钮，后端负责授权。
- 前端从 `@app/contracts` 导入生成 API/类型，按需使用 `@yss123/cage-client`；不导入 domain、内核或数据库包。
- 多页面业务必须有独立 URL，不用 useState/tab 模拟整页导航；详情从 URL 取 ID 并独立加载。前端路由集中在 app，页面从模块公开入口接入 Outlet。登录后保留原路径/query/hash，401 回登录，403 展示权限提示；/admin/ 使用普通链接进入独立系统管理。前端路由不替代后端授权。实现、SPA 部署回退和浏览器配方见 docs/ai/routing.md。
- 跨聚合写入通过 reaction 调用命令。`tx: 'same'` 共同提交/回滚，默认 outbox 异步执行。资源 acquires/releases 是图规则标签，实际占用/释放仍由命令完成；离开持有状态要检查每条释放路径。
- 批量调用同一命令使用 reactionEach，声明 maxItems、唯一排序字段 orderBy、items 和 map；稳定键排序后串行执行。步骤依赖用 order，同事件同事务分组不得混用有序/无序或重复顺序。保持同事务回滚边界，见 docs/ai/primitives.md。
- 审批通过 approval + route 配置，结论是 process 命令；选中审批人不等于已具备能力、范围和额度。parallel(title, ...branch(...)) 声明结构化 AND：分支同时开始，内部顺序独立，全部活动分支完成后汇合；when 支持嵌套并仍按提交快照求值，声明有深度/数量边界，不支持任意跳转。currentSteps 表示当前活动节点集合，兼容字段 currentStep 只是最小活动索引，不能据此隐藏其他分支。人工节点 assignment: 'candidate' 开放候选领取/释放，approver.field 从 routable 字段选人；actions 开放转办、委派归还和前后/并行必签。任务操作与决定携带 revision，waiting 任务只能查看。approvalOperations() 为框架通用时效运行时：step.sla 配置自然分钟节点总时限，route.reminders 配置申请人催办；迁移并运行 worker 后提供持久站内提醒、已读与 Admin 通用页面，不自动批准或授予权限。政策、SDK 和边界见 docs/ai/approvals.md。第三方 IO 通过连接器，回调验签后调用 external 命令。
- job 的读取与调用必须列入 reads/calls。业务导入/导出放在需要的业务页面调用通用任务接口，202 只代表任务已接受；worker 必须运行。
- 已部署事件只做兼容扩展；新增字段设为 optional，不兼容含义用新事件。已执行/已发布迁移不能改写，结构更新新增迁移。
- 不手改生成物，不关闭门禁掩盖错误，不因方便自动授予生产角色新能力。unsafe 必须写明 reason/owner，不能替代普通业务声明。
- 按前述详细中文注释规范完成文件、API、业务声明和关键流程说明；避免无业务价值的防御分支和静默兜底。维护脚本用 TypeScript，不新增 .mjs。

### 最小命令形状

```ts
// 片段：Order 为已导出的聚合，OrderSubmitted 为事件，业务校验按需求添加。
/**
 * 将草稿订单提交审批：只有 draft 可进入 pending_approval。
 * 入口使用 Order.submit 能力，真实授权、范围、状态和版本由内核检查；声明本身不自动授予权限。
 * handler 返回草稿供后续校验和持久化，OrderSubmitted 随命令事务登记，后续由已配置消费者处理。
 * 失败不会提交这次业务变更；事件已登记也不代表后续审批已经完成。
 */
export const submitOrder = command(Order, {
  name: 'submit',
  from: 'draft',
  to: 'pending_approval',
  emits: [OrderSubmitted],
  handler: (draft) => draft,
});
```

完整可添加的普通管理对象见 `docs/ai/primitives.md` 的 Note；采购模板的审批、资源、第三方示例在 `packages/domain/src`，空白模板的参考源码在 `docs/examples/purchase-admin`。先读本项目 AGENTS.md 中的模板说明，区分运行代码与参考资料。API 以当前包公开导出和生成契约为准，不发明不存在的配置和方法。

### 启动、验证与排错

在项目根目录执行：首次 `pnpm install`，复制并编辑 .env.example，仅提供已有库管理员连接后 `pnpm exec cage init`；再 `pnpm build:app`、`pnpm gen`，审查后 `pnpm migrate`；用 `pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json` 显式初始化组织，最后 `pnpm dev`。已有配置不能覆盖，凭据文件必须是新受限文件且父目录存在。

init 只准备账号/schema/授权并填写三个连接，不创建数据库；APP/READ/MIGRATE 指向同一个库。已有集群账号复用原密码，日常启动不用管理员。普通项目不新增 Docker 生命周期命令。

API 日常启动不初始化组织、不输出管理员密码；生产缺少合格 Cookie 密钥会拒绝启动。bootstrap 不自动授予业务能力。`/healthz` 只表示存活，`/readyz` 检查必要依赖。首阶段 API 与 worker 同版本部署，查看实际注册指纹和消费者心跳。

- `pnpm exec cage graph`：浏览器图谱，默认端口 15418，以终端为准。
- `pnpm exec cage context command:对象.命令 --format json --out .cage/context.json`：按完整 key 取精简上下文；默认 Markdown，可用 --depth/--limit 调整范围。CLI 每次重新抽取；Web“复制 AI 上下文”使用当前页面快照，改代码后先刷新图谱。
- `graph inspect/path` 有歧义时复制候选完整 key；path 默认沿箭头，--direction both 的逆向遍历不表示执行方向。报告中的测试/前端文件是候选，须核对；context 与图谱查询不覆盖当前图或命名快照。
- `pnpm exec cage capabilities 关键词 --format json`：查当前安装版本公开签名；`cage doctor`：区分注册、生成、构建、迁移、授权与实际进程证据，unknown 不能当作通过。`cage timeline/explain` 关联实际异步证据与解释授权，参数和权限见 docs/ai/diagnostics.md。
- 生成方法支持 signal/timeoutMs/idempotencyKey 请求选项。底层 CageResult 与 mutation 行为有区别：useCageCommand 失败抛 CageCommandError，成功才返回业务数据。订阅 client.subscribe 在退出、401、切换账号时取消查询并清除应用缓存。
- `pnpm exec cage gen --check`：生成一致性；`pnpm exec cage sync --check`：本托管区一致性。
- `pnpm exec cage test --only project`：业务测试；`pnpm verify`：类型、依赖、lint、图规则、生成、托管区、预算和测试。
- `pnpm exec cage verify --skip-tests` 表示不完整门禁；派生测试跳过不能当作通过。测试连接只用独立测试集群。
- 重要业务改动验证成功路径及有风险的反例；文档或可逆的小改动不反复跑全量数据库测试。
- 修改页面/导航后实际验收深链接、刷新、前进后退、登录回跳、无权限和 404；生产再查 SPA 回退。check/verify 不自动完成浏览器验收，未执行要明确报告。见 docs/ai/routing.md。
- CLI 报错先看 code/at/reason/fix，再查错误码册；HTTP 错误查 runtime.md。异步失败先看 worker、同步记录和死信，修复后重放，不能直接 SQL 改状态。

框架托管区由 cage sync 更新；项目独有的业务规则写在标记之外，避免升级覆盖。
<!-- cage:end -->
