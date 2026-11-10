# 原生智能助理与 AI 审批

[返回学习入口](../README.md) · [审批与命令](../reference/primitives.md) · [架构与执行模型](../getting-started/architecture.md)

这是当前框架的可选运行能力，使用自研持久状态机，不依赖 DeepSeek-Harness。框架提供模型适配、工具、任务、记忆、HTTP 和 SDK；应用提供领域声明、审核策略、角色授权及界面。开发阶段的 `cage context` 查询源码本体，与这里面向登录用户的运行时助理用途不同。

## 按需求定位接入点

编程工具从项目 `AGENTS.md` 进入本页，按需求阅读对应部分。公开符号以当前安装包为准，片段中的业务对象和角色必须来自当前应用。

| 需求关键词 | 公开入口 | 本页使用说明 |
| --- | --- | --- |
| AI审批、智能审批、转人工 | `@yss123/cage-approval` 的 `step`、`AiStepOptions` | “AI 是一个正常审批步骤”；沿用 `approval`，声明三态及真实角色 |
| 业务助理、本体助理 | `@yss123/cage-ai` 的 `ai` | “启用后端”“助理工具来自注册表”；框架编译工具，应用提供声明 |
| 页面上下文、随页助理 | `@yss123/cage-client` 的 `useAssistant`、`useAiPageContext`、`AiPageContext` | “SDK 传入页面内容”；应用维护界面与语义快照 |
| 模型管理、动态配置 | `@yss123/cage-ai` 的 `managedModel` | “启用后端”；Admin 配置连接，部署配置凭据加密密钥 |
| Responses | `managedModel` 的 Admin 协议选项；代码配置用 `responsesModel` | “Responses 会话与上下文配置”；实际验证网关接续及压缩支持 |
| 性格、自定义人设 | `useAssistant`、`client.ai`；类型由 `@yss123/cage-ai-protocol` 提供 | “Admin 配置助理性格”；内置预设与自定义表达，不改变审核策略 |
| 上下文预算、大本体 | `@yss123/cage-ai` 的 `AiContextOptions`，传入 `ai({ context: ... })` | “大本体按需加载”；工具、历史、页面与输出共同受预算约束 |

在应用根目录按需查询，例如：

```powershell
pnpm exec cage capabilities "AI审批" --format json
pnpm exec cage capabilities "页面上下文" --format json
pnpm exec cage capabilities "Responses" --format json
```

`capabilities` 返回框架公开 API；`cage context "业务关键词"` 定位本项目的业务声明。后者未发现业务节点时，仍需查前者判断框架是否已有接入能力。未安装的包或未命中的关键词也不能证明框架不支持；核对包版本、公开符号和本页说明。

接入时分别记录以下证据：

| 状态 | 核对内容 |
| --- | --- |
| 框架支持 | 所需依赖的公开导出、签名与指南存在；浏览器只依赖 client、协议和契约 |
| 项目已启用 | domain 根入口导出 `ai()`、API/worker 使用相同声明、系统迁移已执行、模型及相关角色权限已配置；有助理需求时包含 `assistant` 并接入 SDK |
| 实际验证通过 | 真实角色和模型下完成本次需求的读取、交互、审批或写入验收；报告通过、跳过与未执行项 |

先查现有 domain 入口，已有 AI 运行时就扩展该声明；框架只允许一个 `ai()` 运行时。空白模板只注册组织模型，`docs/examples/purchase-admin` 是参考源码，不代表启用了助理。标准范例可沿 `packages/domain/src/integrations/intelligence.ts`、`packages/domain/src/modules/purchase/approvals.ts` 和 `apps/web/src/shared/ui/assistant-panel.tsx` 阅读，路径规则见[学习入口](../README.md)。后端循环、通用工具、会话表和性格管理使用框架；应用侧完成业务策略、授权与界面组合。

## 启用后端

在应用 domain 包安装与框架同版本的 `@yss123/cage-ai`，把声明从 domain 根入口导出。API 和 worker 使用同一 domain，标准 `createServer` / `startWorker` 自动装配服务，不需要手写业务路由或后台循环。

```ts
import { ai, managedModel } from '@yss123/cage-ai';

export const intelligence = ai({
  models: {
    main: managedModel('main'),
  },
  assistant: {
    model: 'main',
    instructions: '请用中文解释，并引用读取到的对象或规则。',
    confirmWrites: true,
    limits: { maxSteps: 12, maxToolCalls: 30, tokenBudget: 40_000, timeoutMs: 120_000 },
  },
  maxConcurrentRuns: 2,
  maxQueuedPerUser: 8,
  delegationTtlMs: 30 * 60_000,
});
```

`managedModel` 是框架托管的模型入口。应用引用稳定别名，实际模型名称、HTTP / HTTPS API 基地址、API Key、接口协议、上下文窗口、超时及启停状态在 `/admin/#/models` 配置。可声明多个入口供审批和助理分别使用。不需要在业务项目定义模型配置表、管理路由或环境变量读取逻辑。

部署向 API 和 worker 注入同一份 `CAGE_AI_ENCRYPTION_KEY`（32 字节随机密钥的标准 Base64），也可通过连接器 `SecretProvider` 提供。它是加密模型凭据的部署主密钥，不是模型 API Key；应稳定保存并与数据库分开备份。不要随进程启动重新生成，也不要直接轮换它而不重新加密旧配置。未配置时不能保存 API Key。

向管理者显式授予 `Sys.ai.models.manage` 后，在 Admin 填写服务信息并启用，保存后点击“测试连接”。普通助理用户不需要此管理能力。接口与页面均不回显 API Key，留空保留旧值；更换服务地址必须同时填写新密钥，避免把旧密钥转发到新的地址。更新需要配置版本，冲突时刷新后重试。配置按租户隔离，使用 AES-256-GCM 加密，变更与不含密钥的审计同事务提交。

每个模型步进重新读取配置，API 与 worker 无需重启；已发出的请求继续使用当时的快照。托管模型始终调用实际服务，独立于 ERP 等连接器的 `CAGE_STAGE=fake`。接口协议可选 **Chat Completions** 或 **Responses**，服务须支持所选协议的 SSE 与函数工具。地址可填 `https://服务主机/v1` 或完整的 `/chat/completions`、`/responses` 路径，框架按协议选择终点。连接测试只发送固定诊断文字，不携带业务数据；成功不代表工具支持或审批判断质量已验收。

需要代码配置或离线测试时，可使用 `chatModel('language-model', { model, hosts, secret, fake })` 或同包导出的 `responsesModel`：`secret` 是 SecretProvider 的密钥名称；默认遵循 `CAGE_STAGE`，fake 阶段必须显式提供模拟函数且禁止外呼；`environment: 'test' | 'prod'` 可独立选择真实模型环境。自定义 `credential` 解析器只在服务端按次调用，不参与声明序列化。两者默认 HTTPS，可显式设置 `protocol: 'http:'` 连接 HTTP 网关。所有标准模型外呼经过框架连接器的地址校验、限流、取消和超时。

### Responses 会话与上下文配置

Admin 的 `apiFormat` 默认 `chat-completions`，旧模型升级后保持该协议；选择 `responses` 后启用服务端接续。`contextWindowTokens` 默认 32768，可配置 8192 至 2000000，必须按实际模型容量填写；窗口包括输入、输出及推理 Token，和 `assistant.limits.tokenBudget` 的单轮累计消耗分别控制。代码模型使用同名选项。

Responses 请求使用 `store: true` 和 `previous_response_id`。框架持久化返回的 response ID，后续只发送新增用户消息或 `function_call_output`；每次都重发当前系统规则、性格和页面上下文，因为服务不会继承前次的 instructions。更换模型配置版本、权限或注册声明后不接续旧链。worker 重启通过数据库中的接续状态继续，浏览器不维护也不能指定 response ID。

`previous_response_id` **不免除历史 Token 的上下文占用和输入计费**。Admin 的“服务端自动压缩”默认关闭，仅当服务明确支持 `context_management` 时开启；代码模型可设 `compaction: true`。框架在配置窗口的 60% 设置压缩阈值，不开启自动丢弃最早输入的 truncation。部分兼容网关虽然提供 `/responses`，但会拒绝 `previous_response_id`（例如要求 OpenAI API-key account）；框架识别这一稳定错误并从本地完整记录重建当前请求，不把它当成业务失败，也不偷偷切换 Chat 协议。参考 [OpenAI 会话状态](https://developers.openai.com/api/docs/guides/conversation-state)和[压缩说明](https://developers.openai.com/api/docs/guides/compaction)。

远端链条超过本地估算预算，或服务返回历史不存在时，框架用本地记录重建有界请求。原始工具计划、命令回执及模型返回的不透明推理项仍在后端；同配置恢复时保留原生输出项，跨配置不复用它们。已完成的命令从回执恢复，不再次提交。外部服务的会话保存不能代替 Cage 的审计、授权和恢复记录。

升级执行系统迁移 `cage:ai_context_001` 和 `cage:ai_execution_001`：前者增加模型协议/窗口及接续状态，后者将调用预留、尝试次数、接续兼容性及工具预算单独持久化；不改写已有迁移。旧运行的已有计数保留，不追溯推测其费用。前端调用 `client.ai` 的发送、流式订阅与交互方法不变。

只有 AI 审批时可以省略 `assistant`。`ModelProvider` 是服务端扩展接口，可适配其他协议；适配器必须响应 `AbortSignal`。运行时仍会在超时后放弃等待，迟到结果不会被提交。

审查并执行 `pnpm migrate` 后再启动 API/worker。新增命名系统迁移由框架携带，`cage doctor` 会列出未执行项。不要把建表放到服务启动。管理员显式向使用助理的人授予 `Sys.ai.use`，再按需授予领域 `read`、命令与范围；启用服务不自动授予业务权限。

## Admin 配置助理性格

性格是框架提供的租户配置，无需应用声明性格聚合或编写工具。启用 `ai({ models, assistant })`、执行系统迁移后即可使用；管理员需显式获得 **`Sys.ai.personalities.manage`**，从 `/admin/#/personalities` 管理。它与 `Sys.ai.models.manage`、普通用户的 `Sys.ai.use` 分开授权。

框架内置六种业务无关的预设：

| key | 名称 | 表达特点 |
| --- | --- | --- |
| partner | 靠谱搭档（默认） | 自然直接，先讲结论和下一步 |
| minimalist | 极简高手 | 简短明确，减少铺垫 |
| teacher | 耐心老师 | 分步解释，帮助理解概念 |
| energetic | 元气搭子 | 轻快积极，适当表情 |
| detective | 冷面侦探 | 分清证据、推断和待核实事项 |
| butler | 幽默管家 | 得体幽默，重要结论表达清晰 |

管理员可编辑预设，也可新增自定义性格：名称、头像符号、自然语言描述、回复长度、用户称呼、表情频率和最多三句说话示例。每租户含预设最多 30 种；通过启停控制用户是否可选。默认项必须已启用，停用默认项之前需先设置其他默认项。配置和默认项分别使用版本号防止覆盖并发修改，并留下事务审计。预设从框架代码读取，只有实际编辑时才保存租户覆盖值。

“试聊一下”使用未保存的编辑内容和应用助理绑定的模型，逐段显示回复，可随时停止；不携带业务工具、页面、会话历史或记忆，不保存成正常会话。每次只调用一次模型，最多 600 个输出 Token、20 秒，同一用户同时一条、每个运行时最多四条。它用于体验语气；正常助理仍有本体与工具上下文，措辞可能有所不同。

会话的 `personalityKey: null` 表示跟随租户默认。用户也可选择具体性格，切换保留会话、历史和页面上下文。**每次提交消息时保存完整性格快照**，之后的编辑、默认项调整或切换仅影响后续消息；已提交的任务及幂等重试继续使用原快照。若显式选中的性格被停用，下次提交会要求重新选择，框架不会偷偷替换。

性格只作用于助理的表达。AI 审批不加载它；工具可用性、读取范围、写入确认、参数校验和业务状态约束均由服务端执行层决定，性格描述不能更改这些约束。普通用户的目录仅包含名称、符号、key 和版本，不公开内部描述与示例。

SDK 的状态层可直接接到应用自己的下拉框或卡片：

```tsx
const assistant = useAssistant(client.ai, page);
// assistant.personalities：已启用的性格摘要。
// assistant.personality：当前表达身份；personalityKey 为 null 表示跟随默认。
// assistant.defaultPersonalityKey：租户默认项。
// assistant.personalityBusy / personalityError：切换状态与错误。
await assistant.setPersonality('teacher');
await assistant.setPersonality(null); // 恢复跟随默认
await assistant.refreshPersonalities(); // 再次打开面板时刷新配置
```

以上 hooks 和 `client` 从 `@yss123/cage-client` 导入，`page` 是应用提供的页面上下文。切换期间应用应暂时禁用发送和交互按钮；正在生成时 hook 不接受切换。`AiRun.personality` 是该轮实际使用的摘要，历史消息标签应从运行结果读取，不能用当前选择重新标注旧回复。字段型式与管理接口均在浏览器可用的 `@yss123/cage-ai-protocol`，AI 运行时不进入浏览器。

非 React 应用可使用 `client.ai.personalities()`、`createSession({ title, personalityKey })` 和 `selectPersonality(sessionId, { key, version: session.personalityVersion })`。旧的 `createSession('标题')` 调用仍可使用。管理客户端另有 `personalitySettings()`、`savePersonality()`、`savePersonalitySettings()` 和返回完整结果的 `previewPersonality()`；Admin 的即时试聊使用同一预览接口的 POST SSE 模式。

升级已有应用时，新的 `cage:ai_personalities_001` 系统迁移新增配置表及会话/运行字段，旧会话自动跟随默认。执行迁移并显式授予管理能力即可；不需要修改业务声明或重新创建会话。

## AI 是一个正常审批步骤

在原有 `step` 中声明 `kind: 'ai'`，可放在人工节点前后，也可成为唯一或最后一个节点。下面是组合片段：`Document`、`Submitted`、`Withdrawn` 与三个结论命令来自应用现有领域模块。

```ts
import { approval } from '@yss123/cage-kernel';
import { route, step, approver } from '@yss123/cage-approval';
import { Document, Submitted, Withdrawn, accept, reject, revise } from './document.js';

export const review = approval(Document, {
  process: 'document-review',
  start: Submitted,
  cancelOn: [Withdrawn],
  routable: [],
  onApproved: accept,
  onRejected: reject,
  onReturned: revise,
  automatedBy: 'ai_reviewer',
});

export const reviewRoute = route('document-review', [
  step('智能审核', {
    kind: 'ai',
    model: 'main',
    instructions: '检查说明是否足以支持申请。材料不足时退回并给出修改建议；无法可靠判断则转人工。',
    context: { fields: ['reason'], queries: [] },
    handoff: approver.role('reviewer'),
    limits: { maxSteps: 5, maxToolCalls: 8, timeoutMs: 60_000 },
    onFailure: 'manual',
  }),
  // 如需后续人工审批，在此继续加入普通 step。
]);
```

`handoff` 指定当前节点的接管人，不创建嵌套流程。三个模型结果分别是 `pass`、`return`、`manual`：

| 结果 | 流程行为 | 领域行为 |
| --- | --- | --- |
| pass | 推进下一个步骤；已经是末步则结束 | 末步调用 onApproved |
| return | 结束本次审批轮次 | 调用 onReturned，通常进入可修改状态 |
| manual | 当前步骤创建人工待办 | 由接管人通过、拒绝或退回后继续 |

三个结论命令必须属于该聚合并声明 `invokedBy: 'process'`。`onReturned` 与最终拒绝 `onRejected` 独立。修订后再次触发 start 事件，会创建新轮次，从第一个步骤重新开始；旧步骤和旧任务不能继续生效。通知申请人可以由结论命令发事件，再接已有通知反应/连接器；框架不会猜测通知渠道。

`automatedBy` 是真实组织角色的 code，不是模型可选身份。角色需显式拥有对象读取、所需查询读取、通过/退回命令，以及相应范围与额度。没有隐式全范围，也不冒充提交人。`sod.notSameAs` 要求可核验的真人操作人，自动节点不能绕过该约束；这种命令会转人工。

`context.fields` 白名单定义单据上下文；`context.queries` 引用已导出的 query 名称，AI 可按查询 schema 补参数。审核阶段只能调用这些查询、`review_decide` 及读取本次证据的 `context_read`，不能访问其他会话、动态加载其他业务工具或调用助理写工具。证据引用会校验来源是否已提供，但不会把模型判断当作数学证明。

模型故障、预算耗尽或无裁决默认转人工，原因明确记录为系统失败。`onFailure: 'failed'` 则保留失败步骤，须修复配置并通过应用的撤回/重提流程恢复。找不到接管人时同样记录失败，不静默通过。单据版本已变化时迟到裁决被拒，需撤回/重新提交当前内容。

`client.approvalHistory(aggregate, id)` 查看当前可读对象的轮次、节点、理由和建议。生成解释如涉及额外查询范围或敏感明文，会进一步核验访问者授权；无权查看的解释返回 `detailRestricted: true`。原有待办接口新增 `POST /api/approval/tasks/:id/return`。

## 助理工具来自注册表

框架从聚合、命令、查询和审批声明构建运行本体；`pnpm gen` 也输出 `generated/ai/ontology.json`。运行时默认直接使用当前注册表生成的清单。传入 `ontology` 时必须匹配注册指纹。清单不包含 handler 源码、原始 SQL、隐藏字段或模型密钥。

| 工具 | 执行边界 |
| --- | --- |
| ontology_search | 当前权限内的本体摘要目录，支持关键词、聚合和分页 |
| ontology_describe | 按 key 展开 overview / fields / input / related；字段、关联节点可分页 |
| tool_search / tool_load | 搜索在预算内自动加载命中工具；已知 key 可显式加载；均保留完整 schema 与授权校验 |
| context_read | 按本会话 runId / 动作引用 / path 分页取回页面、回执和早期对话；重新核验授权指纹 |
| data_get / data_list / data_related | ReadSide 的只读账号、安全视图、掩码和读取审计 |
| data_query | 有界字段/过滤/统计计划，注册字段映射成参数化查询，不接收 SQL |
| query_* | 为已有 query 生成，沿用 reads 和输入校验 |
| command_* | 为允许 user 调用且已授权的命令生成；修改须携带 expectedVersion |
| approval_history | 当前可读单据的审批轮次、步骤进度与审核理由；沿用审批记录的解释权限过滤 |
| approval_tasks / approval_decide | 当前用户自己的待办；决定走审批引擎与结论命令 |
| request_input / request_page_context | 持久化互动、释放执行者，收到回复再继续 |
| memory_remember | 确认后保存偏好；最多 50 条，可查询和删除 |

普通写操作默认需要确认，可由应用明确设置 `confirmWrites: false`。记忆保存始终需要确认。确认展示的是持久动作计划；回复不能换命令、目标、参数或版本。批量操作由多个独立动作串行处理，具有各自回执与确认，不承诺整批事务原子性。

### 大本体按需加载

完整本体只在后端构建和索引，不整份塞进每个模型请求。框架按完整工具定义的估算 Token、协议工具数量上限，以及扣除系统规则、页面、历史和输出预留后的实际空间选择工具。全部授权工具能在预算内放下时直接提供，不加入工具搜索与加载入口；超出时按显式加载结果、本轮问题、页面聚合和表单命令选取候选，并提供发现工具。没有固定“超过 8 个业务工具就搜索”的规则。

`tool_search` 返回摘要、分页信息及 `loaded/notLoaded`，同时将能放下的候选完整定义持久化，下一次模型请求即可调用，不需要再经历一次 `tool_load` 决策。`tool_load` 供已知 key 的显式选择使用；定义无法完整容纳时明确报错。选择与搜索回执同事务保存，停机后可恢复；搜索只准备工具，绝不直接执行业务命令。

应用可在框架的 `ai()` 声明中调整延迟与上下文的取舍，无需编写业务工具：

```ts
ai({
  models: { main: managedModel('main') },
  assistant: { model: 'main', limits: { maxSteps: 12, maxModelRetries: 2 } },
  context: { maxToolTokens: 8000, maxTools: 128, maxHistoryTokens: 12000 },
});
```

这些可选上限仍受模型窗口和本轮剩余预算约束。默认工具预算取窗口的 25%（至少容纳通用工具），`maxTools` 默认 128 且包含通用工具；默认近期历史预算不超过窗口的 40% 或本轮输入预算的一半。若工具定义较大，可在真实窗口允许的范围内提高 `maxToolTokens`。Token 是跨供应商的保守估算，框架另预留窗口的 10% 作为误差余量，不应当作精确计费分词器。

本体搜索使用确定性关键词及中文相邻词匹配，返回摘要和 `total/nextOffset`；它没有语义向量检索。未命中时可缩短关键词、按聚合筛选或空查询分页浏览全部授权目录。`ontology_describe` 可读取已声明输入、规则与双向对象关系，不把当前页面限定为整个业务范围。约束或不变量只导出名称时，模型不能从名称推断未声明的条件或阈值。读取权限和命令权限分别判断，只有创建能力的人也能发现合法创建输入；流程专用命令不能被加载为助理写工具。

上下文预算统一计入系统指令、性格、页面事实、消息历史、工具定义和工具结果，并为输出及估算误差留空间。工具 schema 和本轮用户问题不被截断；工具定义过大时减少候选，显式加载仍放不下则要求分批或调整真实模型窗口。无法容纳必要输入时报 `AI_CONTEXT_TOO_LARGE`；累计预算耗尽时报 `AI_BUDGET_EXCEEDED`。

大型页面/结果只向模型发送有界预览，完整的已授权上下文与工具返回值保存在数据库，可用 `context_read` 按引用、路径和分页取回。查询本身的行数上限仍然有效：预览收起与查询截断是不同层次，未查询的行需继续分页或缩小范围，不会凭空存入回执。长历史优先收起旧轮次，再整体收起已完成的工具调用/结果组；不会拆散配对，或删除持久记录。最近的工具组和当前问题保持完整。

Chat Completions 和本地重建按预算读取近期完整交互，包括用户补充、工具调用、回执及最终回答，不固定只取六轮问答。每条运行只取自己的消息段，避免历史递归重复。失败或取消的轮次会注明状态，未配对调用不会伪装为成功；用户补充在当前轮次不作为普通工具结果裁成预览。超过窗口时逐个移出旧轮次，原文可用 `context_read` 的 `conversation` 来源及 `messages` 路径分页找回；不透明推理项只用于协议恢复，不经该工具返回给模型。

Responses 正常接续只发新增条目；明确拒绝接续时释放本次预留并从本地重建，不消耗有效模型步数。尝试次数有独立上限 `maxSteps + maxModelRetries`，后者默认 2、允许 0 至 8，避免故障造成无限重试。网关“不支持接续”的标记独立保留，重启或后续会话轮次不会重复探测；新会话或模型配置版本改变后可以重新尝试。启用压缩不等于压缩已经发生，预算不因开关自行假定历史缩小。

旧轮次不因新权限复用：权限指纹或注册指纹变化会拒绝旧运行输出/互动。偏好是用户数据，不可用来存放凭据、授权或代替业务事实。

这种结构保留原始规则与证据的可访问性，但不能保证所有模型回答与全量输入完全一致。关键词召回、模型是否继续取证、服务端压缩都可能影响效果。应评测跨模块查询、少见术语、长上下文原文回查、规则例外、权限变化和审批转人工；不能只以请求变小或连接成功作为精度验收。

## SDK 传入页面内容

前端只依赖 `@yss123/cage-client` 和生成契约。应用明确提供语义上下文，SDK 不抓取整个 DOM。

```ts
import { client, AiPageContext } from '@yss123/cage-client';

// record、selectedIds、filters、form 是当前页面已加载的数据与本地状态。
const page = new AiPageContext({
  page: { id: 'document-detail', title: '对象详情', kind: 'form', route: location.pathname },
  subject: { aggregate: 'Document', id: record.id, observedVersion: record.version },
  selection: { aggregate: 'Document', ids: selectedIds },
  view: { aggregate: 'Document', input: filters, visibleIds: [record.id] },
  draft: { command: 'Document.edit', values: form, baseVersion: record.version },
  visibleContent: [{ id: 'help', text: '当前页面的填写提示' }],
});

const session = await client.ai.createSession('当前对象');
if (session.ok) {
  const result = await client.ai.send(session.data.id, {
    message: '帮我检查当前还没保存的说明',
    pageContext: page.snapshot(),
  }, { idempotencyKey: crypto.randomUUID() });
  if (result.ok) {
    const state = await client.ai.watch(result.data.id, event => {
      // 应用把 message.delta / tool.completed / interaction.required 渲染到自己的界面。
      renderEvent(event);
    });
    renderRun(state);
  }
}
```

`pageInstanceId` 区分页面实例，`revision` 由 `page.update(...)` 递增；发送时复制快照。修改另一个标签页不会改变已提交消息。补充页面交互只接受原页面相同或更高 revision，不接受另一个实例。切换到不同对象时页面应创建新 `AiPageContext`，React 页面可按 URL 对象 ID 设置组件 key。

服务端按当前授权重新读取 subject、selection 和 visibleIds。`visibleContent`、标题、筛选描述是客户端提示；草稿标记为未保存，并剔除对应聚合隐藏字段、按权限掩码。它们都不能改变系统指令或授权。不要往可见文字和草稿中装入凭据；草稿只保留对应聚合声明字段，不把自定义命令的任意中间参数当成业务记录。

页面快照最大 64 KiB，选择或可见 ID 最多 100 个，可见文字最多 10 段。上下文过大将明确报告截断并要求缩小范围，不把部分结果当完整业务集合。

React 可使用以下状态层，界面仍由应用编写：

```tsx
const page = useAiPageContext({
  page: { id: 'detail', title: '对象详情', kind: 'detail', route: location.pathname },
  subject: { aggregate: 'Document', id: record.id, observedVersion: record.version },
});
const assistant = useAssistant(client.ai, page);
// assistant.send(message)
// assistant.respond(interaction.id, { approved: true })
// assistant.respond(interaction.id, { answer: '补充参数' })
// assistant.respond(interaction.id, { pageContext: page.snapshot() })
// assistant.cancel()
// 状态：session、run、events、busy、error、streamingText、progress。
// streamingText：当前模型步骤已收到的完整文字，可直接交给应用的 Markdown 组件。
// progress.stage：idle / queued / context / model / tool / waiting / done。
// progress.tool / toolName / toolState：当前工具及执行状态。
```

以上片段的 hooks 从 `@yss123/cage-client` 导入，record/location 是应用路由与数据。SDK 会在卸载、退出和切换账号时取消订阅并清理 hook 状态；应用其他缓存仍须按[开发步骤](../getting-started/workflow.md)处理。

`send` / `respond` 返回的 Promise 等待本轮完成或需要用户交互；界面应在等待期间渲染 `streamingText` 和 `progress`。`run.status`、步数、工具调用数和待确认操作也随事件更新，不必等 Promise 返回。`model.started` 表示开始一次模型调用，`message.delta` 是增量文本，`tool.started` / `tool.completed` 表示实际工具进度；这些事件不包含模型的私有推理内容。新的模型步骤会重置当前文本，最终以 `message.completed` 校准。

`events` 只保留最近 1000 条诊断事件，不要从它重建完整回复；`streamingText` 独立累计，长回复不会丢失开头，断线按事件序号续传。停止后保留已收到的部分文字。Markdown 渲染、滚动跟随和交互卡片由应用负责；采购范例用 `react-markdown` / `remark-gfm` 渲染标题、列表、代码与表格，禁用原始 HTML，并将模型图片转换为说明文字。

模型适配器须在生成期间调用 `onText` 才能实时显示文字。运行时首段立即持久化，后续通常以最多 40ms 的短窗口合并，减少逐 token 数据库往返；HTTP 每 100ms 追赶一次事件，有积压时连续读取。以上是调度间隔，不是总延迟保证，实际首字还受模型推理、worker 排队、网络和数据库耗时影响。

部署时必须保持 SSE 不缓冲：`/api/ai/runs/:id/events` 和 `/api/ai/admin/personality-preview` 使用 HTTP/1.1 或更高协议，关闭代理缓冲、缓存和压缩，代理读超时至少覆盖服务端 55 秒的单次事件流连接。框架返回 `X-Accel-Buffering: no` 和 `Cache-Control: no-cache, no-store, no-transform`；采购范例的 `deploy/nginx.conf` 提供独立 location。若代理仍缓冲，浏览器可能直到请求结束才看到文本。

## 协议、恢复与当前边界

| 接口 | 用途 |
| --- | --- |
| GET /api/ai/admin/models | 本租户托管模型入口和配置状态；不含密钥 |
| POST /api/ai/admin/models/:key | 保存配置（版本校验、加密及审计） |
| POST /api/ai/admin/models/:key/test | 测试已保存的连接（最多 20 秒） |
| GET /api/ai/personalities | 当前租户已启用性格摘要与默认项 |
| GET /api/ai/admin/personalities | 性格管理配置和设置版本；需独立管理能力 |
| POST /api/ai/admin/personalities/:key | 保存预设覆盖或自定义性格；带配置版本 |
| POST /api/ai/admin/assistant-settings | 修改租户默认性格；带设置版本 |
| POST /api/ai/admin/personality-preview | 未保存草稿试聊；Accept: text/event-stream 使用 SSE |
| GET /api/ai/sessions；POST 同路径 | 本人会话列表 / 新建 |
| POST /api/ai/sessions/:id/personality | 选择会话性格；带 personalityVersion，key 可为 null |
| POST /api/ai/sessions/:id/messages | 提交消息；必须有 Idempotency-Key，返回 202 |
| GET /api/ai/sessions/:id/runs | 本人会话轮次 |
| GET /api/ai/runs/:id | 运行状态、结果、等待的互动 |
| GET /api/ai/runs/:id/events?after=N | 有序事件；Accept: text/event-stream 使用 SSE |
| POST /api/ai/runs/:id/interactions/:interactionId | 回复确认、补充输入或页面快照 |
| POST /api/ai/runs/:id/cancel | 取消；已提交的业务动作保留回执 |
| GET /api/ai/memory；DELETE /api/ai/memory/:id | 本人偏好列表 / 删除 |

HTTP 复用会话、CSRF、限流，并持续检查身份。后台委托绑定真实登录 session；注销、过期或授权变化后不继续执行。直接调用服务端 `AiRuntime.submit(ctx, ...)` 的 ctx 必须来自可信认证代码，不接受模型或客户端传入。

数据库保留 `ai_session/run/event/action/interaction/memory`，审批增加独立的 `approval_step`。worker 用 `SKIP LOCKED` 领取任务、定期续租，通过租约 token 阻止旧执行者提交。每个会话串行，跨会话可以并发；某个任务结束就补充空闲名额，已有慢请求时也会每 100ms 检查空闲名额可领取的新任务。并发和连接器限流是每进程上限。等待互动不占执行者，但仍受委托期限限制。

模型调用前持久化尝试次数和独立预算预留，完成后按 usage 结算消耗并增加有效步数；明确接续拒绝释放预留，网络中断或崩溃导致结果未知时保守结算一次预留。工具计划先落库，业务写入与动作回执同事务提交。进程在提交后中断也不会重复写；回执不依赖 24 小时内核幂等缓存。读工具可重试。三次相同工具无进展、步数/尝试次数/调用/Token 预算或总超时会终止；输入校验与业务冲突可以成为 Observation 供模型修正。

`context.updated` 记录全量/发现模式、加载数量与估算预算；`model.completed` 记录请求耗时、首段文字到达时间、用量来源和工具调用数量；`model.failed` 区分明确拒绝与结果未知。首段文字时间从调用模型适配器开始计量，包含连接器限流及网络耗时，不等同于上游服务自身的 TTFB。

排查失败时，`AI_TIMEOUT` 表示整个运行超过截止时间；`AI_MODEL_TIMEOUT` 表示单次模型请求超时。HTTP 拒绝、限流、网络异常、上游流内错误、输出上限、响应缺失或格式异常分别使用 `AI_MODEL_HTTP_ERROR`、`AI_MODEL_RATE_LIMITED`、`AI_MODEL_CONNECTION_FAILED`、`AI_MODEL_UPSTREAM_ERROR`、`AI_MODEL_OUTPUT_LIMIT`、`AI_MODEL_INCOMPLETE`、`AI_MODEL_RESPONSE_INVALID`。`model.failed` 保存 `code/reason/durationMs/firstTextMs`，有证据时附带 HTTP 状态及稳定错误码，不保存上游错误正文、密钥或 JSON 解析器片段。未知异常仍使用 `AI_EXECUTION_FAILED`，不能仅凭这个代码判断超时；这些分类不自动开启失败重试。

Token 使用优先按模型返回 usage 核算；缺少 usage 时使用文本估算和输出预留额度，不能用于精确计费。兼容服务分词方式不同，输入窗口仍需留余量。上下文采用目录检索、有界输入及可选的 Responses 服务端压缩，没有向量检索或长期业务事实知识库。当前不提供通用浏览器操作、任意代码/SQL 执行、第三方非幂等写工具或现成聊天页面。运行记录不自动清理，部署时须为这些表制定保留策略；审计与回执清理不能破坏仍有效的操作去重。

## 接入后的验收

按本次接入范围验证，不必为只调整入口文档的变更重复数据库和模型测试：

- 业务助理：使用普通角色完成一次实际只读查询，核对结果来源及数据范围；需写入时检查确认内容、取消确认和版本冲突，只有成功回执才显示完成。
- 随页界面：验证当前对象、选中项、未保存草稿和页面切换；生成期间展示增量文字与工具进度，完成后核对 Markdown，退出或切换账号时清理状态。
- AI 审批：覆盖 pass、return、manual，检查退回修改后的新轮次从头开始；模型失败应按节点配置转人工或留在失败状态，不得伪造通过。
- 管理配置：验证模型连接和一次实际工具交互，性格切换作用于后续消息；需要 Responses 接续或压缩时分别核对实际支持，连接成功不能替代这些验证。

`cage doctor` 可辅助检查注册、迁移和进程证据，但未知项不能当作通过；诊断用法见[能力发现与状态诊断](../tools/diagnostics.md)。模型输出质量需要应用使用自己的规则样例评测。框架验证的是权限、状态、预算和事务边界；发布前需使用实际模型服务、实际角色和审批样例联调。
