# CAGE-STATE-010

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:67](../../packages/cli/src/rules.ts)

```ts

/** CAGE-STATE-010：每个状态都能从初始状态到达；CAGE-STATE-011：非终态必须有出边 */
export function checkStates(g: Ontology): Finding[] {
  const { get } = index(g);
  const findings: Finding[] = [];
  for (const a of g.nodes.filter((n) => n.kind === 'aggregate')) {
```

## 怎么修

让 from/to 引用已声明的状态，初始状态可达，非终态有出边，结束状态列入 terminal。

## 正例

```text
states('draft', 'done', { terminal: ['done'] });
```

## 反例

```text
command(Order, { from: 'missing', to: 'done', handler: o => o });
```
