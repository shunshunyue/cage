# CAGE-GEN-003：输入校验需要服务端执行

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：gen --check / verify。

refine/superRefine、transform 等可执行校验无法无损转换到生成的客户端 schema，报告包含字段路径。

## 修复步骤

1. 阅读诊断定位的命令和字段；把可表达规则声明成标准 schema，保留服务端作为最终校验。
2. 确需自定义逻辑时，在页面解释业务拒绝并处理领域错误；不要认为契约生成成功代表执行函数已被复制。

## 正例

```text
strict、multipleOf、default 使用标准 Zod 声明；自定义规则按字段报告降级
```

## 反例

```text
把服务端 refine 丢失当作客户端校验完全等价
```

## 修复后验证

重新生成并审查后执行 cage gen --check；结构变化还需审查并执行 migrate。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/gen/index.ts:120`
- `packages/cli/src/gen/zod-code.ts:62`
- `packages/cli/src/gen/zod-code.ts:89`
- `packages/cli/src/gen/zod-code.ts:105`
- `packages/cli/src/gen/zod-code.ts:182`

实现片段（位置随框架版本更新）：

```ts
    for (const diagnostic of schemaDiagnostics(entry.input)) findings.push({
      code: 'CAGE-GEN-003', severity: 'warning', at: `${entry.name}:${diagnostic.path}`,
      reason: diagnostic.reason, fix: '前端校验只提供即时提示，以服务端命令校验为准；不要复制可执行函数到契约。',
    });

```
