# CAGE-EVENT-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:225](../../packages/cli/src/rules.ts)

```ts

/** CAGE-EVENT-002：事件载荷只允许向后兼容的变更（只能新增可选字段） */
export function checkEventCompat(base: Ontology, head: Ontology): Finding[] {
  const findings: Finding[] = [];
  const b = new Map(base.nodes.filter((n) => n.kind === 'event').map((n) => [n.id, n]));
  for (const ev of head.nodes.filter((n) => n.kind === 'event')) {
```

## 怎么修

保留旧事件字段及类型，新加字段设为 optional；不兼容含义使用新事件名。

## 正例

```text
event("OrderChanged", { orderId: id(), note: text().optional() })
```

## 反例

```text
// 给已有事件新增必填 note，旧 outbox 消息无法提供它
```
