# CAGE-APPR-010

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:140](../../packages/cli/src/rules.ts)

```ts

/** CAGE-APPR-010：invokedBy 为 process 的命令必须有审批绑定或反应调用它，否则没有人能调用 */
export function checkProcessCommands(g: Ontology): Finding[] {
  const { into } = index(g);
  const findings: Finding[] = [];
  for (const c of g.nodes.filter((n) => n.kind === 'command')) {
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
