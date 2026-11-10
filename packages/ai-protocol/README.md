# @yss123/cage-ai-protocol

Cage AI 的共享协议与 Zod 校验包，供浏览器 SDK、HTTP 接口和服务端运行时使用同一套消息、页面快照、运行状态、交互、模型配置与性格类型。只依赖 Zod，不导入数据库、React、模型适配器或 AI 执行循环。

需要自定义 AI 界面、校验输入或消费类型时直接使用；需要发送消息与订阅 SSE 时使用 `@yss123/cage-client`，需要运行助理时使用 `@yss123/cage-ai`。

## 安装

```powershell
pnpm add @yss123/cage-ai-protocol
```

包的开发工具链要求 Node.js 24+；协议代码可用于浏览器，与其余 Cage 包保持同一版本。

## 校验一条消息

下面的代码可在浏览器执行，不会发起网络请求。页面快照不装入凭据，服务端仍会根据当前身份重新读取业务事实。

```ts
/** 先验证页面和消息形状，再交给应用的 client.ai.send 提交。 */
import {
  messageInputSchema,
  pageContextSchema,
  type AiMessageInput,
} from '@yss123/cage-ai-protocol';

const pageContext = pageContextSchema.parse({
  pageInstanceId: crypto.randomUUID(),
  revision: 0,
  capturedAt: new Date().toISOString(),
  page: {
    id: 'notes',
    title: '部门便笺',
    kind: 'list',
    route: '/notes',
  },
});

const parsed = messageInputSchema.safeParse({
  message: '请说明这个页面有哪些操作',
  pageContext,
});
if (parsed.success) {
  const input: AiMessageInput = parsed.data;
  console.log(input.message);
} else {
  // 展示校验问题；此处没有提交消息，也不代表服务器已授权。
  console.error(parsed.error.issues.map((issue) => issue.path.join('.')));
}
```

`parse` 校验失败会抛出 Zod 错误，`safeParse` 返回成功/失败联合。严格对象 schema 会拒绝未声明字段；只有 TypeScript 类型的响应接口不会自动执行运行时校验。

## 主要入口

| 入口 | 作用 |
| --- | --- |
| `pageContextSchema`、`PageContext` | 页面实例、修订号、当前对象、选中项、筛选与草稿 |
| `messageInputSchema`、`AiMessageInput` | 消息输入；文本去首尾空白、非空且最长 16000 字符 |
| `runStatusSchema`、`AiRun`、`AiSession` | 排队、执行、等待交互与终态，会话和运行结果 |
| `AiEvent`、`AiEventType` | 运行内有序事件、文本增量及工具进度 |
| `interactionResponseSchema`、`AiInteraction` | 确认、补充输入、补充页面快照 |
| `aiDecisionSchema` | 审批 `pass/return/manual`、理由、建议与证据引用 |
| `modelConfigSchema`、`AiModelConfig` | 模型管理输入与公开配置 |
| 性格相关 schema 和类型 | 性格目录、编辑、选择与预览协议 |
| `queryPlanSchema`、`QueryPlan` | 结构化查询计划协议，不执行 SQL |

`AiEvent.data` 是 `unknown`，自定义消费者需按事件种类检查载荷；不能把类型断言当作校验。事件序号只在所属运行内有意义。

schema 通过仅说明形状与长度合法，不证明对象存在、审批结论正确或用户有执行权。页面中的可见文字与草稿是不可信输入；最终授权、字段掩码、事务和状态迁移由服务端负责。

## 文档

- [AI 协议、页面上下文与 SDK](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/intelligence.md)
- [公开协议源码](https://github.com/shunshunyue/cage/blob/main/packages/ai-protocol/src/index.ts)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
