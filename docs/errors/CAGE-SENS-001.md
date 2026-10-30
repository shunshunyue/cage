# CAGE-SENS-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:114](../../packages/cli/src/rules.ts)

```ts

/** CAGE-SENS-001：敏感字段不得原样进入事件载荷 */
export function checkSensitiveEvents(g: Ontology): Finding[] {
  const { get, out } = index(g);
  const findings: Finding[] = [];
  for (const c of g.nodes.filter((n) => n.kind === 'command')) {
```

## 怎么修

从事件移除敏感字段，或保留与聚合一致的 sensitive 标注，让运行时脱敏。

## 正例

```text
event('OrderChanged', { phone: text().sensitive('phone') })
```

## 反例

```text
event('OrderChanged', { phone: text() }) // 来源字段是敏感电话
```
