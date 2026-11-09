# @yss123/cage-ai

Cage 的服务端 AI 运行时。把领域声明编译为受授权约束的工具，提供持久会话、模型与工具执行循环、写入确认、页面上下文、偏好记忆、流式事件和 AI 审批。运行状态、交互与命令回执保存在 PostgreSQL，worker 负责执行。

本包运行在 API/worker，不能导入浏览器。网页使用 `@yss123/cage-client`，共享类型使用 `@yss123/cage-ai-protocol`；聊天页面和业务审核策略由应用编写。

## 安装与启用

需要 Node.js 24+、PostgreSQL，以及同版本 Cage 框架。在应用 domain 包中安装：

```powershell
pnpm add @yss123/cage-ai
```

创建 `packages/domain/src/integrations/intelligence.ts`，并从 domain 根入口导出。一个应用只能启用一个 `ai()` 声明；已有声明时扩展它。

```ts
/** 应用 AI 声明；API 与 worker 共享此配置，导入时不连接模型或数据库。 */
import { ai, managedModel } from '@yss123/cage-ai';

/** 使用托管模型提供中文业务助理；业务写入必须先确认且仍经内核授权。 */
export const intelligence = ai({
  models: { main: managedModel('main') },
  assistant: {
    model: 'main',
    instructions: '请用中文解释，并引用读取到的对象或规则。',
    confirmWrites: true,
    limits: {
      maxSteps: 12,
      maxToolCalls: 30,
      tokenBudget: 40_000,
      timeoutMs: 120_000,
    },
  },
  maxConcurrentRuns: 2,
  maxQueuedPerUser: 8,
});
```

```ts
// 加入现有 domain 根入口，保留组织模型和其他业务导出。
export * from './integrations/intelligence.js';
```

接入顺序：

1. 运行 `pnpm gen`，审查并执行 `pnpm migrate`，部署同版本 API 和 worker；标准 `createServer/startWorker` 自动装配 AI。
2. 向 API 与 worker 注入同一份 `CAGE_AI_ENCRYPTION_KEY`：32 字节随机密钥的标准 Base64，用于加密模型凭据。稳定保存，不在源码或聊天中保存真实值。
3. 向管理者授予 `Sys.ai.models.manage`，进入 `/admin/#/models` 配置 `main` 的实际地址、模型、协议、API Key、窗口和超时，启用后测试连接。
4. 向助理用户授予 `Sys.ai.use`，同时授予所需业务读取、命令能力和数据范围。启用 AI 不自动增加业务权限。
5. 前端接入 `client.ai` 或 `useAssistant/useAiPageContext`，完成真实角色、模型和业务操作验收。

`managedModel` 始终调用实际模型服务，不随 ERP 的 `CAGE_STAGE=fake` 自动变成模拟模型。连接测试成功只证明基本连接，不证明工具、Responses 接续或审批质量。

## 模型、审批与上下文

| 公开入口 | 用途 |
| --- | --- |
| `ai`、`AiOptions` | 声明运行时、模型别名、助理策略、预算与并发 |
| `managedModel`、`ModelManager` | 稳定模型别名及租户级动态管理 |
| `chatModel`、`responsesModel` | 代码配置的协议适配器；可提供明确 fake 做离线测试 |
| `ModelProvider` | 服务端自定义模型适配接口，应响应取消信号并报告使用量 |
| `AiRuntime` | 由框架装配、绑定 Kernel 的持久运行服务；普通应用不另写执行循环 |
| `AiContextOptions` | 本体、工具、历史和页面内容的上下文预算 |

AI 审批使用 `@yss123/cage-approval` 的 `step(..., { kind: 'ai', ... })`，沿用原有 `approval` 结论命令，三种结果为 `pass/return/manual`。只有审批需求时可省略 `assistant`。自动执行角色、转人工规则和失败行为必须在业务声明中明确配置。

浏览器页面快照只提供定位与未保存草稿，服务端重新读取授权范围内的事实。模型建议不能越过命令状态、范围、版本和硬约束；用户确认也不会扩大权限。等待互动不是业务完成，取消不会回滚已经提交的动作。

运行时提供有界执行和恢复记录，不提供任意 SQL/代码执行、通用浏览器操作或现成聊天页面。托管性格只改变助理表达，不改变审批策略或授权。运行记录需由部署方制定保留策略；不得清理仍用于去重的有效回执。SSE 部署需关闭代理缓冲，并按实际服务能力配置 Responses 接续与压缩。

## 文档

- [完整接入、模型管理、审批三态与流式 SDK](https://github.com/shunshunyue/cage/blob/main/docs/ai/intelligence.md)
- [能力发现与运行诊断](https://github.com/shunshunyue/cage/blob/main/docs/ai/diagnostics.md)
- [采购范例的 AI 声明](https://github.com/shunshunyue/cage/blob/main/examples/purchase-admin/packages/domain/src/integrations/intelligence.ts)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
