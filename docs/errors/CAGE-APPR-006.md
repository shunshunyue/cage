# CAGE-APPR-006

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/approval/src/route.ts:97](../../packages/approval/src/route.ts)

```ts
  if (!/^[a-z][a-z0-9-]*$/.test(process)) throw declError('CAGE-APPR-005', `流程名 ${process} 必须是小写短横线`);
  if (nodes.length === 0) throw declError('CAGE-APPR-006', `流程 ${process} 至少需要一个步骤`);
  const fields = new Set<string>();
  for (const n of nodes) {
    const steps = n.kind === 'step' ? [n] : n.steps;
    if (n.kind === 'when') fields.add(n.cond.field);
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
