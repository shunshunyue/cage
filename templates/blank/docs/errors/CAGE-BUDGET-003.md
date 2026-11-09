# CAGE-BUDGET-003：新增未经基线认可的 unsafe

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：budget / verify。

本次图中的 unsafe 数超过给定基线；没有基线时允许值为零。

## 修复步骤

1. 优先移除逃生口；确需使用时写明 reason/owner，评审后更新受审基线。不要用刚改后的图冒充旧基线。

## 正例

```text
unsafe({ reason: '受审的历史修复', owner: '负责人' }, action) 并使用受审基线
```

## 反例

```text
随手调用 unsafe，再覆盖基线隐藏增长
```

## 修复后验证

重跑 cage budget；有 unsafe 基线时使用真实受审基线。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/budget.ts:98`

实现片段（位置随框架版本更新）：

```ts
    findings.push({
      code: 'CAGE-BUDGET-003',
      reason: `unsafe 从 ${allowance} 增加到 ${graph.unsafeCount}`,
      fix: '移除新增逃生口，或在评审完成后更新受审基线',
    });
```
