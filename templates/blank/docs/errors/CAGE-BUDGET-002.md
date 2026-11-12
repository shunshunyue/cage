# CAGE-BUDGET-002：公共原语超过词汇预算

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：budget / verify。

框架公共词汇计数超过当前 16 个预算。

## 修复步骤

1. 优先组合现有原语；确需增加公共概念时由框架维护者评审，不由业务项目随意扩展品牌。

## 正例

```text
用 command/event/reaction 组合新业务
```

## 反例

```text
每个业务动作新增一个框架原语
```

## 修复后验证

重跑 cage budget；有 unsafe 基线时使用真实受审基线。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/budget.ts:91`

实现片段（位置随框架版本更新）：

```ts
    findings.push({
      code: 'CAGE-BUDGET-002',
      reason: `品牌原语 ${primitives} 个，超过 16 个预算`,
      fix: '优先使用组合子，避免新增原语',
    });
```

</details>
