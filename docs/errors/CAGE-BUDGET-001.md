# CAGE-BUDGET-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/budget.ts:45](../../packages/cli/src/budget.ts)

```ts
    findings.push({
      code: 'CAGE-BUDGET-001',
      reason: `内核 ${lines} 行，超过 5000 行预算`,
      fix: '拆出扩展职责，或提交架构评审调整预算',
    });
  if (primitives !== null && primitives > 16)
```

## 怎么修

减少内核职责，移除不必要的 unsafe；预算调整及基线更新必须经过评审。

## 正例

```text
node packages/cli/bin/cage.js budget
```

## 反例

```text
// 未评审就增加公共原语或 unsafe 数量
```
