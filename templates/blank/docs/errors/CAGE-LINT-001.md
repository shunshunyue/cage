# CAGE-LINT-001：lint 语法或规则错误

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：verify。

verify 将没有专属 CAGE 码的 ESLint 诊断汇总为该码。

## 修复步骤

1. 看同条诊断的 ruleId、文件和行号，修复具体语法/规则后重跑；不要把通用码当成单一故障。

## 正例

```text
按原 ESLint 诊断修复后运行 pnpm verify
```

## 反例

```text
删除 lint 配置或全局 disable
```

## 修复后验证

按原诊断的文件、行号和 ruleId 修复，再运行相关 lint/verify。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/verify.ts:114`

实现片段（位置随框架版本更新）：

```ts
    f.messages.map((m): Finding => ({
      code: /\[(CAGE-[\w-]+)\]/.exec(m.message)?.[1] ?? 'CAGE-LINT-001',
      at: `${f.filePath}:${m.line}`,
      reason: m.message,
      severity: m.severity === 1 ? 'warning' : 'error',
```
