# AI 模型、工具、上下文与恢复参考

接入步骤见[原生 AI](../guides/intelligence.md)。本页解释服务端模型、助理协议和持久执行边界；公开签名来自 cage-ai、cage-client 和 cage-ai-protocol。

## 模型与管理配置

managedModel 使用稳定别名，实际配置按租户保存在 Admin。管理需 Sys.ai.models.manage，性格管理需 Sys.ai.personalities.manage，普通交互需 Sys.ai.use。凭据用部署主密钥 AES-256-GCM 加密，配置与无密钥审计共同提交。

API Key 留空保留原值；换地址时需同时提供新密钥，避免将旧密钥发送给新地址。保存带配置版本，冲突后刷新。每个模型步进重新取配置，已发请求使用原快照，API/worker 无需为配置编辑重启。

例如管理员表单把实际地址、模型和新密钥交给保存函数；API Key 仅来自用户输入，不写进源码。version 应先从 models() 读到：

<!-- cage:check web ai-save-model -->
```ts
export const modelCatalog = () => client.ai.models();
export const saveMainModel = (version: number, baseUrl: string, model: string, apiKey?: string) =>
  client.ai.saveModel('main', {
    version, label: '业务主模型', baseUrl, model, apiKey, enabled: true,
    apiFormat: 'responses', contextWindowTokens: 32768, responsesCompaction: false,
  });
```

协议可选 Chat Completions 或 Responses，服务需支持相应 SSE 和函数工具。地址可用 /v1 基地址或完整终点。contextWindowTokens 默认 32768，可设 8192–2000000，按真实模型容量填写。

例如保存后单独测试 main 的连接。测试成功只证明该版本的简单请求完成，工具调用和审批样例仍要另验：

<!-- cage:check web ai-test-model -->
```ts
export const testMainModel = () => client.ai.testModel('main');
```

代码配置可使用 chatModel/responsesModel：hosts 为环境主机，secret 是 SecretProvider 名称。普通模型阶段默认遵循 CAGE_STAGE，fake 需明确 fake 函数；environment 可选择真实 test/prod。默认 HTTPS，公开选项可显式使用 HTTP 网关。ModelProvider 用于服务端适配，需响应 AbortSignal；迟到结果不会提交。

例如服务器 integrations 中可以定义一个 Responses provider，再用它替换既有 ai().models.main；不要再创建第二个 AI 运行时：

<!-- cage:example responses-model -->
```ts
import { responsesModel } from '@yss123/cage-ai';

/** 声明允许的网关和真实窗口；主机、模型标识需换成实际服务，secret 只保存密钥名称。 */
export const mainModel = responsesModel('main', {
  model: 'your-model',
  hosts: { test: 'ai-sandbox.example.com', prod: 'ai.example.com' },
  secret: 'AI_API_TOKEN',
  environment: 'test',
  contextWindowTokens: 32768,
  compaction: false,
});
```

这是代码配置的替代接法；使用 managedModel 时继续在 Admin 配置。构造 provider 不发请求，实际服务必须支持对应协议，32768 也要按真实模型容量核对。

## Responses 接续

Responses 保存 response ID，后续携带 previous_response_id 并只发新增条目；系统规则、性格和页面上下文每次重新提供。模型配置、权限或注册指纹改变后不继续旧链，浏览器不能指定该 ID。

例如用户同一会话先问“列出我的便笺”，再问“把第二条展开”。浏览器只提交两条普通 message；接续标识由服务端保存和选择，不作为前端参数：

<!-- cage:check web ai-continued-message -->
```ts
export const askInExistingSession = (sessionId: string, message: string, idempotencyKey: string) =>
  client.ai.send(sessionId, { message }, { idempotencyKey });
```

服务必须实际支持接续与可选压缩。压缩默认关闭，开启时按窗口的 60% 提供阈值，不启用自动截掉最早输入的 truncation。接续不代表历史不再占上下文。

例如已经核对网关支持压缩，代码 provider 才显式开启；真实主机和模型仍按部署配置填写：

<!-- cage:check domain ai-compaction -->
```ts
export const compactingModel = responsesModel('main', {
  model: 'your-model', hosts: { test: 'ai-sandbox.example.com' },
  secret: 'AI_API_TOKEN', environment: 'test', contextWindowTokens: 32768, compaction: true,
});
```

明确接续不兼容、历史不存在或远端链超预算时，用本地记录重建有界请求。稳定的不支持标记跨重启保留，新会话或新配置可以重试；这不会自动切换协议。工具计划与已提交命令从本地回执恢复，远端会话存储不能代替审计。

例如第二轮遇到“不支持接续”，框架从本地历史重建该协议的请求；已成功的 Note.archive 回执继续复用，不因重建模型请求再归档一次。普通网络失败也不能直接解释为“接续不支持”。

## 性格与会话

内置 partner、minimalist、teacher、energetic、detective、butler 六种预设，租户可覆盖或新增，总数最多 30。配置名称、符号、表达、长度、称呼、表情和示例；默认项必须启用，配置与默认项分别做版本检查。

例如用户创建“简洁表达”的会话，或选择 null 跟随租户默认；目录从服务端读取，不在页面虚构可用性格：

<!-- cage:check web ai-personality-session -->
```ts
export const availablePersonalities = () => client.ai.personalities();
export const createConciseSession = () => client.ai.createSession({ title: '便笺查询', personalityKey: 'minimalist' });
export const createDefaultSession = () => client.ai.createSession({ title: '便笺查询', personalityKey: null });
```

试聊使用未保存内容与助理模型，不带业务工具、页面、历史或记忆，也不成为正常会话。最多一次模型调用、600 输出 Token、20 秒，同用户同时一条、每运行时最多四条。

personalityKey: null 跟随租户默认；具体性格选择保留会话和历史。每条消息提交时保存性格快照，后续编辑影响之后的消息。已选性格停用后需重新选择。公开目录仅返回摘要，审核不加载助理性格。

例如切换既有会话时使用该会话刚读到的 personalityVersion，不使用性格内容的版本：

<!-- cage:check web ai-change-personality -->
```ts
export const changeSessionPersonality = (sessionId: string, version: number, key: string | null) =>
  client.ai.selectPersonality(sessionId, { key, version });
```

useAssistant 提供 personalities、personality、personalityKey、defaultPersonalityKey、setPersonality、切换状态与错误，供应用组合选择界面。

例如 React 组件内建立 assistant 后，可把选择项传给 assistant.setPersonality(key)，回到默认项传 null；发送中的界面同时展示切换 busy/error，不能把本地选中当作已保存。

## 工具的来源与权限

运行本体从同一注册表构建，生成清单可在 generated/ai/ontology.json 查看；显式传 ontology 时校验指纹。清单不含 handler、SQL、隐藏字段或密钥。

| 工具 | 职责 |
| --- | --- |
| ontology_search / ontology_describe | 按权限检索声明摘要、字段、输入和关联，支持分页 |
| tool_search / tool_load | 发现并加载完整工具定义，不直接执行业务 |
| data_get/list/related | 安全读侧读取、掩码和审计 |
| data_query | 有界参数化读取计划，不接受任意 SQL |
| query_* / command_* | 已导出 query 与获授权 user 命令，修改检查版本 |
| approval_history/tasks/decide | 可读单据历史、本人待办和决定 |
| request_input / request_page_context | 持久等待用户补充 |
| context_read | 按引用、路径、分页取回本会话已授权上下文 |
| memory_remember | 确认后保存偏好，最多 50 条，可读和删除 |

普通写入默认需确认，可由应用显式关闭 confirmWrites；偏好保存始终确认。回复不能换掉已保存计划中的目标、参数或版本。批量是多个独立动作与回执，不能推断整批原子。

例如收到本次运行的 confirmation 互动后，只答复同意或拒绝，不在答复中另传“改成其他记录”：

<!-- cage:check web ai-confirmation-response -->
```ts
export const confirmPlan = (runId: string, interactionId: string) =>
  client.ai.respond(runId, interactionId, { approved: true });
export const rejectPlan = (runId: string, interactionId: string) =>
  client.ai.respond(runId, interactionId, { approved: false });
```

偏好也可以查看或删除。例如“以后回答简短一些”经确认保存后，管理的是当前用户偏好，不是给用户增加写权限：

<!-- cage:check web ai-memory -->
```ts
export const myPreferences = () => client.ai.memories();
export const removePreference = (id: string) => client.ai.deleteMemory(id);
```

AI 审批只取声明字段与 query，使用审核裁决及本次证据读取工具。它没有其他会话、自由工具发现或助理写工具。证据来源校验不等于模型判断必然正确。

例如 context.fields 只列 reason 的材料预审，不能以“我还想看用户邮箱”为由读取未授权字段；要求补全时可 return，无法可靠判断时 manual，而不是伪造一条证据。

## 上下文预算与按需发现

预算同时计入系统、性格、页面、历史、工具定义及结果，并预留输出和估算余量。授权工具能完整放下时直接提供；超过实际空间时按当前问题、页面与已加载工具选择，并提供发现入口。

tool_search 在预算内直接持久加载命中定义，下一步即可调用；tool_load 适用于已知 key。工具 schema 和本轮问题不截断，装不下时减少候选或明确失败。搜索使用关键词及中文相邻词匹配，没有向量检索；可缩短关键词、按聚合或分页遍历。

| 选项或额度 | 默认与边界 |
| --- | --- |
| assistant limits | maxSteps 16、maxToolCalls 40、tokenBudget 40000、timeoutMs 120000、maxOutputTokens 4000 |
| maxModelRetries | 默认 2，允许 0–8；额外尝试额度，不等于所有错误自动重试 |
| maxConcurrentRuns / maxQueuedPerUser | 默认 2 / 8；并发最多 32，均为单运行时策略 |
| context.maxTools | 默认且最多 128，包含通用工具 |
| context.maxToolTokens | 默认窗口 25%，仍受实际剩余空间约束 |
| context.maxHistoryTokens | 近期完整交互上限，缺省还受窗口和本轮输入预算限制 |

例如限制单次运行、工具定义、历史和并发，修改已有 ai() 选项，不另注册运行时：

<!-- cage:check domain ai-budgets -->
```ts
export const limitedIntelligence = ai({
  models: { main: managedModel('main') },
  assistant: { model: 'main', confirmWrites: true, limits: {
    maxSteps: 12, maxToolCalls: 30, tokenBudget: 20000, timeoutMs: 120000,
    maxOutputTokens: 2000, maxModelRetries: 1,
  } },
  context: { maxTools: 64, maxToolTokens: 6000, maxHistoryTokens: 8000 },
  maxConcurrentRuns: 2, maxQueuedPerUser: 4,
});
```

例如窗口只有 8192 Token，历史上限填 8000 也不保证能装下：系统、工具和输出还要占空间。输入本身装不下是 AI_CONTEXT_TOO_LARGE；整轮累计额度耗尽是 AI_BUDGET_EXCEEDED，不应静默删掉业务问题。

上下文需要真实窗口，Token 估算不是精确计费分词器。大型页面和结果提供预览，完整已授权内容持久保存后可回查；没查询到的行不在回执中，仍需业务分页。历史优先收起旧轮次与完整工具组，保留原文及配对关系。

必要输入装不下报 AI_CONTEXT_TOO_LARGE，累计额度耗尽报 AI_BUDGET_EXCEEDED。窗口调整、关键词召回和压缩都需用真实问题评测，不能从请求变小推断回答精度不变。

## 页面协议与流式 SDK

AiPageContext 管理 pageInstanceId 和递增 revision，发送时复制快照。同一消息不随后续页面变化；补充上下文只能来自原实例的相同或更新 revision。切换对象应创建新实例。

例如为一条便笺创建实例，之后编辑标题再更新。同一实例 revision 递增，之前拍下的快照保持原值：

<!-- cage:check web ai-page-snapshot -->
```ts
export function pageForNote(record: Note, title: string) {
  const page = new AiPageContext({
    page: { id: 'note-detail', title: '便笺详情', kind: 'form', route: `/notes/${record.id}` },
    subject: { aggregate: 'Note', id: record.id, observedVersion: record.version },
  });
  const beforeEditing = page.snapshot();
  page.update({
    page: { id: 'note-detail', title: '便笺详情', kind: 'form', route: `/notes/${record.id}` },
    subject: { aggregate: 'Note', id: record.id, observedVersion: record.version },
    draft: { command: 'Note.update', values: { title }, baseVersion: record.version },
  });
  return { beforeEditing, afterEditing: page.snapshot() };
}
```

subject/selection/view 的记录由服务端重新授权读取；draft 标明未保存，过滤隐藏字段并掩码。visibleContent 及客户端文字是提示，不是授权或系统指令。草稿只保留对应聚合字段，不接收凭据或任意中间参数。

例如列表只加载第一页、选中两条记录，应分别表达 view 和 selection，不把所选两条当成全部结果：

<!-- cage:check web ai-list-context -->
```ts
export const listContext = (visibleIds: string[], selectedIds: string[]) => new AiPageContext({
  page: { id: 'notes', title: '便笺列表', kind: 'list', route: '/notes?page=1' },
  view: { aggregate: 'Note', input: { page: 1, pageSize: 20 }, visibleIds, visibleFields: ['title', 'status'] },
  selection: { aggregate: 'Note', ids: selectedIds },
});
```

client.ai.send 返回被接受的运行；watch 消费有序 SSE 并在终态取得状态。useAssistant 提供 streamingText/progress、run/events、会话、发送、恢复及互动能力。应用需渲染确认、补充输入和最终 Markdown，并在账号切换时清理自己的状态。

例如非 React 调用先提交，再立即跟踪；onEvent 应实时更新界面，watch 返回等待或终态后再显示相应操作：

<!-- cage:check web ai-send-watch -->
```ts
export async function sendAndFollow(sessionId: string, message: string, key: string, onEvent: (event: AiEvent) => void) {
  const accepted = await client.ai.send(sessionId, { message }, { idempotencyKey: key });
  if (!accepted.ok) return accepted;
  const run = await client.ai.watch(accepted.data.id, onEvent);
  return { ok: true as const, data: run };
}
```

需要补充文字与补充页面快照是两类答复，只能各传一种：

<!-- cage:check web ai-input-and-context -->
```ts
export const answerQuestion = (runId: string, interactionId: string, answer: string) =>
  client.ai.respond(runId, interactionId, { answer });
export const supplyPage = (runId: string, interactionId: string, page: AiPageContext) =>
  client.ai.respond(runId, interactionId, { pageContext: page.snapshot() });
```

## HTTP 入口

| 路径 | 用途 |
| --- | --- |
| /api/ai/admin/models；/:key；/:key/test | 模型目录、保存、测试 |
| /api/ai/personalities | 普通用户的启用性格摘要 |
| /api/ai/admin/personalities；/:key | 管理性格 |
| /api/ai/admin/assistant-settings；/personality-preview | 默认性格与未保存试聊 |
| /api/ai/sessions | 会话列表与创建 |
| /api/ai/sessions/:id/personality；/messages；/runs | 会话选择、发送、轮次 |
| /api/ai/runs/:id；/events；/interactions/:interactionId；/cancel | 状态、SSE、互动与取消 |
| /api/ai/memory；/:id | 本人偏好读取与删除 |

具体方法和输入由 OpenAPI/SDK 给出。写入复用 CSRF，消息必须带 Idempotency-Key；会话绑定真实登录委托，过期、注销或授权变化不能继续执行。服务端 AiRuntime.submit 的 ctx 必须来自可信认证。

例如运行详情、增量事件和取消对应独立入口，after 是同一运行中最后已处理的 sequence：

<!-- cage:check web ai-run-endpoints -->
```ts
export const loadRun = (id: string) => client.ai.run(id);
export const loadLaterEvents = (id: string, after: number) => client.ai.events(id, after);
export const cancelRun = (id: string) => client.ai.cancel(id);
```

## 持久运行与失败

worker 用 SKIP LOCKED、续租和租约 token 保护执行，按会话串行、跨会话有界并发。等待互动释放执行者，仍受委托期限限制；恢复后重新建立执行阶段截止时间。

模型调用前保存尝试与预算预留，完成按 usage 结算；未知结果保守计入预留。工具计划持久化，业务写入和动作回执同事务，因此提交后进程中断也不会重复写。读工具可重试；无进展、尝试、调用、Token 或超时限制会结束运行。

例如归档命令和动作回执已一起提交，worker 随后退出：恢复时读取该回执继续模型对话，不再次执行同一个归档计划。反过来，只有模型说“已归档”却没有成功回执，界面不能报告完成。

AI_TIMEOUT 是执行阶段截止，AI_MODEL_TIMEOUT 是模型请求超时。模型 HTTP、限流、连接、上游流错误、输出上限、不完整响应和格式错误分别归类；model.failed 保留稳定码与安全诊断，不保存密钥或上游正文。分类本身不自动启动失败重试。

例如 60 秒的模型请求先超时得到 AI_MODEL_TIMEOUT；运行整体的 120 秒截止耗尽是 AI_TIMEOUT。等待用户确认后，委托到期仍不能继续，不能以“还没花完 Token”为由忽略身份期限。

运行记录没有自动保留期清理。部署需安排保留政策，不能破坏有效回执去重。当前无任意代码/SQL、通用浏览器、非幂等第三方写工具或现成聊天页面；模型质量、兼容服务和长期容量需应用验证。

[返回开发手册](../README.md)
