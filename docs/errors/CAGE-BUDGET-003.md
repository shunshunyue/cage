# CAGE-BUDGET-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/budget.ts:58](../../packages/cli/src/budget.ts)

```ts
    findings.push({
      code: 'CAGE-BUDGET-003',
      reason: `unsafe 从 ${allowance} 增加到 ${graph.unsafeCount}`,
      fix: '移除新增逃生口，或在评审完成后更新受审基线',
    });
  return { metrics: { kernelLines: lines, primitives, unsafe: graph.unsafeCount }, findings };
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
