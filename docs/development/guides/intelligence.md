# 启用 AI 审批与随页业务助理

Cage 的原生 AI 有两种入口：审批节点判断材料，业务助理帮助当前用户查询或执行操作。两者共用持久运行时与模型配置，但使用不同的策略和执行身份。

本篇先启用运行时，再选择本次需要的入口。普通审批链应先按[审批课程](approvals.md)接通；公开参数和协议查[AI 参考](../reference/intelligence.md)。

## 1. 从 domain 导出一个 AI 运行时

在 domain 包使用同版本的 @yss123/cage-ai，例如 integrations/intelligence.ts：

<!-- cage:example ai-runtime -->
```ts
import { ai, managedModel } from '@yss123/cage-ai';

/** 提供 main 模型和需确认写入的领域助理；模型连接由管理员配置，声明不授予用户权限。 */
export const intelligence = ai({
  models: { main: managedModel('main') },
  assistant: {
    model: 'main',
    instructions: '使用中文解释，依据实际读取到的业务数据回答。',
    confirmWrites: true,
    limits: { maxSteps: 12, maxToolCalls: 30, timeoutMs: 120_000 },
  },
});
```

从 domain 根入口导出。已有 ai() 时扩展原声明，框架只允许一个运行时。仅使用 AI 审批可省略 assistant。API/worker 加载同一 domain，标准装配自动连接运行服务。

运行 check/gen，审查并执行系统迁移，再启动进程。空白模板只注册组织基础，离线采购源码不代表当前应用启用了 AI。

## 2. 配置模型和角色

API 与 worker 注入同一稳定的 CAGE_AI_ENCRYPTION_KEY：32 字节随机密钥的标准 Base64。它用于加密模型凭据，需与数据库分开备份，不能每次启动生成或直接轮换后遗失旧配置。

例如部署平台中的同一密钥项同时注入两个进程。重启时继续引用该项，不在启动代码里生成新值：

```text
部署密钥 ai-master → API 的 CAGE_AI_ENCRYPTION_KEY
                 → worker 的 CAGE_AI_ENCRYPTION_KEY
```

管理员获得 Sys.ai.models.manage，在 /admin/#/models 为 main 填写模型、API 地址、密钥和协议，保存并测试连接。普通用户获得 Sys.ai.use，再按业务授予 read、命令及数据范围；管理模型和使用助理分开授权。

例如 main 保存后由管理员发起测试；普通业务用户只发助理消息，不应得到模型管理能力：

<!-- cage:check web intelligence-probe -->
```ts
export const inspectDeclaredModels = () => client.ai.models();
export const probeMain = () => client.ai.testModel('main');
```

托管模型始终请求实际服务，ERP 的 fake 阶段不会把模型也变成 fake。测试连接只证明简单请求可用，工具、接续、压缩和审核质量分别验证。详细配置见[模型参考](../reference/intelligence.md#模型与管理配置)。

## 3A. 在现有审批中增加 AI 节点

使用既有 approval 和 route，增加 step 的 AI 重载。下面是局部步骤，Document 等业务符号应来自当前应用：

<!-- cage:example ai-review-step -->
```ts
step('材料预审', {
  kind: 'ai',
  model: 'main',
  instructions: '材料足够则 pass；信息缺失则 return 并说明修改项；无法可靠判断则 manual。',
  context: { fields: ['reason'], queries: [] },
  handoff: approver.role('reviewer'),
  limits: { maxSteps: 5, maxToolCalls: 8, timeoutMs: 60_000 },
  onFailure: 'manual',
});
```

approval 需额外绑定 onReturned 和 automatedBy。onReturned 是本聚合的 process 修订命令；automatedBy 是真实执行角色 code，需对象、查询、结论能力与相应范围。handoff 指定本节点的人工接管人，需配置真实人员和授权。

例如基于部门申请课程，用户已确认“材料不足退回草稿”时，补上真实退回命令并替换原绑定：

<!-- cage:check domain intelligence-return-binding -->
```ts
export const returnForRevision = command(ReviewRequest, {
  name: 'returnForRevision', description: '退回申请等待修订', from: 'pending', to: 'draft', invokedBy: 'process',
  handler: draft => draft,
});
export const reviewedBinding = approval(ReviewRequest, {
  process: 'department-request', start: ReviewRequestSubmitted, cancelOn: [ReviewRequestWithdrawn],
  routable: ['deptId', 'reason'], automatedBy: 'ai-reviewer',
  onApproved: approveReviewRequest, onRejected: rejectReviewRequest, onReturned: returnForRevision,
});
```

退回后还需要用户修订说明的命令；否则只有“回到草稿”而不能真正修材料：

<!-- cage:check domain intelligence-revise-request -->
```ts
export const reviseRequest = command(ReviewRequest, {
  name: 'revise', description: '修订草稿申请说明', from: 'draft', to: null,
  input: z.object({ id: z.uuid(), reason: z.string().trim().min(1).max(1000) }),
  handler: (_draft, input) => ({ reason: input.reason }),
});
```

| 裁决 | 结果 |
| --- | --- |
| pass | 通过当前节点，末步时执行 onApproved |
| return | 结束本轮并执行 onReturned |
| manual | 当前节点产生人工待办 |

例如三份材料分别走三条结果，只有节点 pass 不代表整条申请已批准：

```text
说明完整、可核验 → pass → 继续下一人工节点
缺少用途说明   → return → 领域退回草稿，用户修订后新轮次提交
证据互相冲突   → manual → reviewer 角色中的有权人员接管本节点
```

材料修订后重新提交会新开轮次，从第一步开始。AI 审批只使用 context 白名单查询与审核工具，不能调用助理的任意业务写工具；自动身份也不能绕过要求真人身份的职责分离约束。

默认模型失败转人工，onFailure: 'failed' 则保留失败步骤。无接管人、版本变化或授权问题需要实际处理，不能当作通过。用真实模型分别验证 pass/return/manual 与失败路径。

例如模型请求超时但配置了人工接管，应观察到人工待办；把 onFailure 选择为 failed 后，同样超时应保留失败状态，不应产生“审核通过”的页面文案。

## 3B. 将助理接到真实页面

前端使用 @yss123/cage-client。应用提供语义快照，SDK 不抓取整个 DOM。在已经加载 record 的 React 组件中可以这样建立上下文：

<!-- cage:example ai-page-context -->
```tsx
const page = useAiPageContext({
  page: { id: 'note-detail', title: '便笺详情', kind: 'form', route: location.pathname },
  subject: { aggregate: 'Note', id: record.id, observedVersion: record.version },
});
const assistant = useAssistant(client.ai, page);
```

hooks 和 client 从 cage-client 导入。页面按需要补 selection、view、draft 和 visibleContent；切换业务对象时用 URL id 作为组件 key，创建新的页面实例。

界面消费 assistant.streamingText、progress、run、error 和 busy，并在发送后立即展示增量回复与工具进度。assistant.send(message) 的 Promise 覆盖后续跟踪过程，不能等它结束才显示文字。

例如同一个组件中，streamingText 随事件更新，发送按钮只控制当前请求状态：

<!-- cage:check web intelligence-streaming-component -->
```tsx
export function NoteAssistant({ record }: { record: Note }) {
  const page = useAiPageContext({
    page: { id: 'note-detail', title: '便笺详情', kind: 'detail', route: `/notes/${record.id}` },
    subject: { aggregate: 'Note', id: record.id, observedVersion: record.version },
  });
  const assistant = useAssistant(client.ai, page);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  async function send() {
    setError('');
    try { await assistant.send(text); }
    catch { setError('本轮请求未完成，请查看运行状态后再决定是否重试'); }
  }
  return <section>
    <input value={text} onChange={event => setText(event.target.value)} />
    <button disabled={assistant.busy || !text.trim()} onClick={() => void send()}>发送</button>
    <p aria-live="polite">{assistant.streamingText || assistant.run?.answer}</p>
    <p>{assistant.progress.stage}</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
```

应用负责会话列表、输入、Markdown、写入确认和补充输入界面。确认展示已保存的命令计划；只有实际成功回执才说明操作完成。服务端重新核对对象、范围和字段权限，客户端提供的文字与草稿不能改变系统规则或授予权限。

例如拿到当前 run.interactions 中的确认问题后，按钮只回复那个 interactionId；输入型问题只传 answer：

<!-- cage:check web intelligence-hook-interactions -->
```ts
export const approveAssistantPlan = (assistant: ReturnType<typeof useAssistant>, interactionId: string) =>
  assistant.respond(interactionId, { approved: true });
export const answerAssistant = (assistant: ReturnType<typeof useAssistant>, interactionId: string, answer: string) =>
  assistant.respond(interactionId, { answer });
```

底层也可使用 client.ai.createSession/send/watch 等接口组合非 React 界面。完整页面参考采购 shared/ui/assistant-panel.tsx，状态和协议见[AI 参考](../reference/intelligence.md)。

## 4. 按入口验收

助理先用普通角色完成只读查询，核对数据来源和范围；需要写入时检查确认、取消、版本冲突与回执。随页场景验证选择项、未保存草稿、切换对象、流式显示和退出清理。

审批使用本应用的规则样例测试三态、重提、模型失败和人工接管。模型连接、框架支持、应用启用、真实业务结果分别记录；cage doctor 的 unknown 不能算通过。

例如同一条 active 便笺，有 Note.read 的甲可以查询，范围外乙得到不可见；甲确认归档时，另一个页面已经更新版本，写工具仍应报告冲突，而不是凭模型回复改写旧值。

性格影响助理表达，不改变审批规则。大本体、长历史、少见术语和跨模块查询还需质量评测，具体策略见参考页。

[返回开发手册](../README.md)
