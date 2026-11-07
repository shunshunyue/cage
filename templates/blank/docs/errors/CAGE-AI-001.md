# CAGE-AI-001：智能运行时声明无效

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：领域声明 / 模型与运行预算配置。

模型引用未配置、重复启用 AI 运行时，或上下文预算、重试、并发、超时、队列参数非法。

## 修复步骤

1. 在 domain 顶层导出一个 ai({ models, assistant }) 声明，审批 step 的 model 引用同名模型。
2. 预算与并发为正整数；maxModelRetries 为 0 至 8，context.maxTools 最多 128（包含通用工具）。并发最多 32，单次运行 timeoutMs 最多 300000。API 与 worker 使用相同声明和模型配置。

## 正例

```text
ai({ models: { main: provider }, assistant: { model: 'main', limits: { maxSteps: 8 } } })
```

## 反例

```text
ai({ models: {}, assistant: { model: 'missing', limits: { maxSteps: 0 } } })
```

## 修复后验证

重跑 cage check、迁移与相关测试，再以真实角色验证助理和审批；fake 成功不代表真实模型联调完成。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/ai/src/index.ts:56`
- `packages/ai/src/index.ts:64`
- `packages/ai/src/index.ts:68`
- `packages/ai/src/index.ts:70`
- `packages/ai/src/index.ts:71`
- `packages/ai/src/index.ts:72`
- `packages/ai/src/index.ts:74`
- `packages/ai/src/index.ts:76`
- `packages/ai/src/index.ts:78`
- `packages/ai/src/index.ts:107`
- `packages/ai/src/index.ts:111`
- `packages/ai/src/index.ts:113`

实现片段（位置随框架版本更新）：

```ts
  };
  if (!Object.keys(options.models).length) throw declError('CAGE-AI-001', '至少配置一个模型');
  for (const provider of Object.values(options.models))
    if (
      provider.contextWindowTokens !== undefined &&
```
