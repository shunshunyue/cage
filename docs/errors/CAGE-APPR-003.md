# CAGE-APPR-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/flow.ts:139](../../packages/kernel/src/primitives/flow.ts)

```ts
    if (!c.invokedBy.includes('process')) {
      throw declError('CAGE-APPR-003', `审批结论命令必须声明 invokedBy: 'process'`);
    }
  }
  return Object.freeze({
    [APPROVAL]: true as const,
```

## 怎么修

核对流程绑定、可路由字段、结论命令及审批人配置。结论只能调用所属聚合的 process 命令。

## 正例

```text
onApproved: approve // approve 声明 invokedBy: 'process'
```

## 反例

```text
onApproved: otherAggregateCommand // 结论落到了错误聚合
```
