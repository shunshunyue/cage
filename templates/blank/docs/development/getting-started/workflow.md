# 开发步骤与交付要求

[返回学习入口](../README.md) · [框架开发 Skill](../skills/cage-development/SKILL.md) · [完整入门课](first-feature.md) · [详细中文注释](../reference/commenting.md)

本页提供应用启动、修改和验证的操作命令。需求理解、与用户澄清、能力查证和编码前的实现映射统一按[Skill](../skills/cage-development/SKILL.md)执行；下列操作用于落实已经明确的设计。

本页命令在**应用根目录**执行，除非注明“框架根目录”。使用项目安装的 CLI：`pnpm exec cage ...`。项目脚本可简写为 `pnpm gen / pnpm migrate / pnpm dev / pnpm verify`；不要假定机器已全局安装 cage。

## 第一次启动应用

前提是 PostgreSQL 数据库已经存在。框架负责连接与表结构，不负责数据库服务的安装、建库或 Docker 生命周期。

```powershell
pnpm install
# 仅首次复制；已有 .env 时编辑原文件，不覆盖配置。
Copy-Item .env.example .env
# 在 .env 填写 CAGE_ADMIN_DATABASE_URL，指向已有数据库。
pnpm exec cage init
pnpm build:app
pnpm gen
# 审查 db/migrations 中的迁移草稿，再执行：
pnpm migrate
# 迁移后显式初始化组织，目标是新的受限凭据文件；父目录需存在。
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

`init` 自动创建独立账号与随机密码，填写 APP/READ/MIGRATE 连接和 Cookie 密钥，成功后删除文件中的管理员连接。三个连接使用同一数据库。已有 Cage 集群账号时复用原连接，不能重置其他应用的账号密码。生产环境可由平台直接提供账号连接，不必执行本地 init。

`bootstrap` 独立初始化组织，并给初始超级管理员当前及以后新增的全部能力和本租户全部数据范围。超级管理员可以直接为普通角色配置能力和范围；普通角色不会自动获得新增能力。管理员凭据只进入新的受限文件，不进入服务控制台；已有用户时不重置账号，也不会自动升级已有角色。交付后移除凭据文件。日常 API 启动不初始化组织；生产缺少合格 Cookie 密钥会拒绝启动。具体文件权限与诊断用法见[能力发现与状态诊断](../tools/diagnostics.md)。

`.env.example` 是配置说明，`.env` 是本机私密配置，二者不混用。CLI 自动加载应用 `.env`，部署环境同名变量优先。API 和 worker 启动需重启后读取变更；不要输出整个 `.env` 排障。

框架仓库首次先在根目录 `pnpm install`、`pnpm build`，再进入 `examples/purchase-admin` 配置。`dev` 不自动执行迁移；生成新迁移后要审查并显式运行 migrate。

## 按已明确的设计修改业务

只执行实现映射涉及的操作；文案或样式调整无需修改 domain、生成迁移或重新授权。实现过程中发现业务规则尚不清楚，回到[业务澄清](../guides/business-collaboration.md)处理相关部分。

1. **保存基线。** 涉及已存在业务含义变化时，修改前运行 `pnpm exec cage snapshot save before-change`；也可使用真实 Git 提交或独立本体图文件。
2. **修改声明与导出。** 按[目录规范](../reference/project-structure.md)在所属领域模块修改字段、状态、不变量、命令及必要的后续流程。按[本体建模指南](../guides/ontology-modeling.md)把对象含义、关系方向与基数、状态和操作结果写进真实声明；名称用 description、字段 .describe 和每个状态的 labels 维护，普通注释与页面翻译不能代替。跨模块反应放 workflows，第三方协议放 integrations；从模块 index 到 domain 总入口逐层导出，避免重名丢失。按[注释规范](../reference/commenting.md)同步解释职责、输入、权限/状态/reads、事件/事务与失败边界。
3. **检查与生成。** `pnpm exec cage check` 检查声明和图规则，处理 `CAGE-ONTOLOGY-001` 指出的缺名；`pnpm gen` 更新契约与迁移草稿，不手改生成物。名称显示覆盖可写 `cage.config.json` 的 `graph.labels`（如 `aggregate:Note`、`command:Note.archive`、`capability:Note.export`），不重命名能力点来翻译。图谱中核对业务名称、关系、状态迁移与资源生命周期；名称齐全不能证明联动已经实现。
4. **审查与迁移。** 核对非空字段、回填、删列和索引，保留已执行迁移；有结构变化且需落库时显式 `pnpm migrate`。按需要配置能力、范围和外部服务，API/worker 使用一致声明。
5. **接入页面。** 在 `apps/web/src/modules/<业务>` 使用真实生成契约，从模块入口接入 app 路由。处理业务失败与版本冲突；多页面使用独立 URL，筛选/分页进入 URL。`useCan` 只控制按钮，服务端仍校验授权；成功后重新读取或失效查询。按[浏览器验收](../guides/routing.md)检查对应操作和导航。
6. **核对规则与交付。** 对照编码前的规则与验收例子，补足关键反例，执行下文与改动匹配的检查。审查 diff 中的业务变化、生成物和中文注释；交付源声明、契约、审查过的迁移及配置要求，分别报告通过、跳过、未执行。

### 如何保存和比较基线

```powershell
# 修改前执行；同名快照不会覆盖。
pnpm exec cage snapshot save before-change
# 修改 domain 后执行：
pnpm exec cage impact --snapshot before-change
# 或与真实可用的 Git 提交比较；下面的 main 应按仓库实际情况替换。
pnpm exec cage impact --base main
```

基线文件要保留到验收结束。影响分析用于找到相关命令、约束、审批、查询和候选测试，不能当作不需验证的证明。没有 Git 提交时不要为了让命令成功而擅自创建/推送远端。

`context` 和图谱查询只返回查询结果，不更新当前图文件或命名基线；`analyze/gen` 更新当前图。快照来源时间、版本与图指纹随报告保存。

## 常见需求的具体改法

| 需求 | 做法 | 必查项 |
| --- | --- | --- |
| 增加字段 | 修改 aggregate；按命令更新 input/handler；重新生成 | 是否敏感、是否可选、旧数据如何回填、查询/事件/页面受影响吗 |
| 增加状态或撤回 | 修改 states 和 command；声明事件及资源处理 | 可达性、非终态出边、审批 cancelOn、CAGE-PAIR-002 |
| 修改审批 | 修改 route/approval；按需要增加 routable | 负责人/role code、步骤 mode、业务分支条件、结论命令和职责分离 |
| 增加报表 | 声明 query 的 reads、input 和 sql/build | 安全视图、参数化、调用人 read 权限、生成 queries 契约 |
| 接入第三方 | 声明 connector/op/outbound/inbound；配置运行环境密钥 | 请求响应白名单、幂等、超时、验签、永久/可重试错误和补偿 |
| 改后台管理配置 | 通过组织模型与系统接口修改 | 防提权、实际授权范围、角色缓存刷新、操作人权限 |
| 改脚手架 | 先修改标准范例，再同步模板并构建 CLI | 新目录实际创建结果、资料分发、凭证不入包 |

## 前端如何消费框架

```ts
import { purchaseOrder } from '@app/contracts';

// 普通业务接口使用生成的方法；第二个参数可传当前记录的 version。
const result = await purchaseOrder.submit(order.id, order.version);
if (!result.ok) {
  // 按 code 展示通用原因；DOMAIN_ERROR 还可以按 domainCode 展示业务文案。
  showError(result.domainCode ?? result.code);
} else {
  refreshOrder(result.data);
}
```

这是页面事件处理片段，`order/showError/refreshOrder` 由业务页面提供。不要导入 domain 命令在浏览器执行，也不要复制后端权限逻辑。生成契约只包含允许 user 调用的写操作；审批通过通过待办接口进行，而不是自己增加 `purchaseOrder.approve()`。

对自定义 HTTP 协议能力使用 `@yss123/cage-client`；它负责会话、CSRF 和类型化结果。需让多个提交共享幂等键时，按当前客户端接口显式传递同一次业务操作的 key，并在页面阻止重复进行中的提交。生成契约的方法签名以 `packages/contracts/src` 为准，不假设每个命令方法都支持自定义 options。

生成方法最后的请求选项支持 `signal/timeoutMs/idempotencyKey`。底层返回 `CageResult`；`useCageCommand` 成功返回业务数据、失败抛出 `CageCommandError`，因此 mutation 的 `isSuccess` 表示业务成功。退出、401、切换账号时订阅 `client.subscribe` 取消用户查询并清除应用缓存，范例 `apps/web/src/app/use-session.ts` 展示了接法。

### 导入和导出属于业务页面

框架提供通用异步接口与任务查询，页面放在哪里由具体业务决定。

- 导出调用生成的 `purchaseOrder.export(params, options?)` 等方法，得到任务；使用 `client.transfer(id)` 或 `useTransfer(id)` 查看进度，完成后通过 `client.transferDownloadUrl(id)` 下载。
- 导入调用 `client.importCsv('PurchaseOrder.create', csv, { atomic: false })` 等，目标是已声明且支持用户调用的命令；每行执行命令，复用权限和业务校验。该例中的 `items` 等复杂字段需遵守实际 CSV 编码规则，不是任意 Excel 文件自动识别。
- `atomic: true` 请求整批原子处理，普通逐行导入需展示成功/失败计数及报告。HTTP 202 仅代表接受任务，不能立即提示处理完成。
- worker 必须运行；任务可能 queued/retrying/failed/expired。下载会再次校验当前权限。导出的系统列和掩码值不能原样回导。

CSV 编码、限制、SDK 与完整接口见本项目自带的[业务页导入导出](../guides/transfers.md)。给新业务做入口时按实际生成的签名调用，不硬编码采购单专属逻辑进框架。

## 工具做什么，结果在哪里

| 命令 | 用途 | 主要输出 |
| --- | --- | --- |
| `pnpm exec cage analyze` | 抽取显式声明与源码位置 | `.cage/ontology.json` |
| `pnpm exec cage capabilities 关键词 --format json` | 查询当前安装版本的公开能力 | 公开签名、声明位置和学习入口 |
| `pnpm exec cage doctor` | 统一核对注册、生成、构建及可用运行证据 | pass / fail / unknown 与下一步；见[诊断指南](../tools/diagnostics.md) |
| `pnpm exec cage snapshot save 名称` | 保存不可覆盖的命名基线 | `.cage/snapshots`；配合 `impact --snapshot 名称` |
| `pnpm exec cage check` | 静态检查、注册表与图规则 | 终端 `code/at/reason/fix` |
| `pnpm exec cage graph` | 启动中文本体图谱 | 默认 `http://127.0.0.1:15418`，按终端地址访问 |
| `pnpm exec cage context "需求或节点"` | 开发前取得相关子图、原因、源码与候选验证 | 默认终端 Markdown；`--format json --out .cage/context.json` 保存结构化报告 |
| `pnpm exec cage graph search/inspect/path ...` | 检索候选 / 精确节点 / 关系路径 | 同源中文与证据；每次重新抽取，见[用法](../tools/ontology-context.md) |
| `pnpm gen` | 更新契约、结构说明、迁移草稿 | `packages/contracts/src`、`db/migrations`、`generated`、`.cage/ontology.json` |
| `pnpm exec cage gen --check` | 只比较需提交的生成物 | 不一致时报 CAGE-GEN；不是实际数据库漂移扫描 |
| `pnpm exec cage test --only project` | 项目测试 | `.cage/test-results.json` 与终端 |
| `pnpm exec cage test --only derived` | 声明派生的框架性质测试 | `generated/tests`、同一测试报告 |
| `pnpm verify` | 汇总门禁 | `.cage/verify.json` |
| `pnpm exec cage verify --skip-tests` | 执行测试以外的门禁 | 报告标明 `complete: false`，不可称全量通过 |
| `pnpm exec cage sync` / `sync --check` | 同步/比较 AGENTS 托管区 | 保留标记外的项目自有规则；不自动改写业务代码或学习资料 |
| `pnpm exec cage budget` | 体积、公共词汇和 unsafe 预算 | 终端 metrics/findings |
| `pnpm exec cage upgrade --dry-run` | 查看当前目标 CLI 所带升级改动 | 文件修改预览；应先安装正确目标版本 CLI |

`generated/` 和 `.cage/` 是可再生资料；contracts 和迁移是需要审查、提交的生成结果。生成迁移通过最后一个迁移内嵌的结构快照比较，不是创建临时数据库，也不能证明真实库从未被手工改动。

## 验证要与改动匹配

- 文档、文案、可逆的小改动：检查链接、格式、资料分发；不需要重复运行全套数据库测试。
- 所有源码变更：按[注释交付清单](../reference/commenting.md#交付前逐项核对)人工核对中文职责、接口与关键流程说明；静态检查不能替代注释准确性检查。仅补注释时不新增复述实现的测试、不改写已执行迁移。
- 命令/约束/反应变化：针对成功路径及真正的风险增加用例，如越权拒绝、业务条件边界、资源释放、同事务回滚。不要写只复述实现的测试。
- 领域结构变化：check、gen、生成一致性、类型检查；有数据库影响时在独立测试库验证迁移和读写。
- 页面或导航变化：构建后按[浏览器配方](../guides/routing.md)实际操作，包含深链接、新标签页、刷新、前进后退、登录回跳、无权限和 404。check/verify 不自动执行浏览器验收；未操作时明确报告未执行，不能写“页面功能完整”。
- 发布前：按项目要求执行完整 verify/build/test，核对分发包。没有执行的项目明确写出原因。

测试使用真实 PostgreSQL。`CAGE_TEST_DATABASE_URL` 供独立测试集群使用，测试工具会准备角色和临时数据库；不要指向业务/生产集群。没有设置时 testkit 可使用内嵌的真实 PostgreSQL，这与 dev 的固定已有库流程不同。

派生测试无法凭空推断所有业务合法输入，会报告跳过。它们证明的是通用性质，不能代替采购 happy path、审批配置和第三方真实联调。

## 交付说明

可复用的需求输入见[任务模板](../guides/recipes.md#给编程工具的任务模板)，工作流程使用 Skill，不另维护一套提示词。

交付说明至少包含行为变化、源文件、生成物/迁移、角色授权需求、详细中文注释覆盖的主要职责与边界、验证结果，以及尚未做的真实外部联调。注释未覆盖项如实说明，不能用聊天中的解释代替源码注释。遇到错误先修复根因；不把待办未生成、任务已接受或 fake 成功写成业务全部完成。
