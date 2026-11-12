# @yss123/cage-ai-protocol

浏览器与服务端共用的 AI 类型和 Zod schema，包括消息、页面快照、运行状态、互动、模型及性格。只依赖协议与校验，不加载数据库、React 或模型执行循环。

## 校验消息

安装 pnpm add @yss123/cage-ai-protocol，与其他 Cage 包保持同版本：

```ts
import { messageInputSchema, type AiMessageInput } from '@yss123/cage-ai-protocol';

/** 只校验消息形状，不发送请求，也不授予读取任何对象的权限。 */
const message: AiMessageInput = messageInputSchema.parse({
  message: '查看当前可读的部门便笺',
});
```

需要发送/订阅时使用 cage-client，需要执行运行时使用 cage-ai。页面快照还含实例、revision、时间、对象和草稿；服务端重新授权读取业务事实。

## 状态与边界

AiRunStatus 区分 queued、running、waiting_input、waiting_confirmation 和各终态；HTTP 接受消息不等于工具完成。AiEvent 按运行内 sequence 排序，互动答复引用具体 interaction ID。

schema 校验只证明形状，可信身份、角色范围、命令版本与策略由执行层判断。客户端文字和未保存草稿不能成为权限或系统指令，协议中不装凭据。

[随页接入](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/intelligence.md) · [协议参考](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/intelligence.md)
