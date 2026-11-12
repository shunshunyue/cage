# @yss123/cage-ai

Cage 服务端 AI 运行时：模型适配、授权工具、持久会话、确认与回执、页面上下文、偏好记忆和 AI 审批。API 接受请求，worker 执行；浏览器使用 cage-client 与 cage-ai-protocol。

## 从 domain 启用

安装 pnpm add @yss123/cage-ai，使用同版本 Cage、Node.js 24+ 与 PostgreSQL：

```ts
import { ai, managedModel } from '@yss123/cage-ai';

/** 注册 main 模型和领域助理；连接由 Admin 配置，普通写入需要确认。 */
export const intelligence = ai({
  models: { main: managedModel('main') },
  assistant: { model: 'main', confirmWrites: true },
});
```

一个应用只导出一个 ai()，已有声明直接扩展。执行系统迁移，API/worker 注入稳定 CAGE_AI_ENCRYPTION_KEY，管理员配置 main 模型。使用者获 Sys.ai.use 及业务能力和范围，管理模型/性格另授管理能力。

仅 AI 审批可省略 assistant，审批 step 使用 kind: 'ai'，绑定自动角色、onReturned 和真实接管人。审核身份、政策与助理性格分别管理。

## 执行边界

工具来自当前注册表，读写继续受内核约束。计划和回执持久保存，写入及回执共同事务提交；取消等待或模型失败不能伪造业务回滚。框架没有现成聊天页面，应用组合流式 SDK 和确认界面。

chatModel/responsesModel/ModelProvider 用于服务端适配。托管模型实际外呼不受 ERP fake 阶段替代；协议、工具、接续和模型质量分别测试。运行记录需部署规划容量与保留策略。

[接入指南](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/intelligence.md) · [模型、上下文与恢复](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/intelligence.md)
