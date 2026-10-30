# CAGE-QUERY-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:168](../../packages/cli/src/rules.ts)

```ts

/** CAGE-QUERY-003：手写 SQL 只能引用 reads 里聚合的安全视图 */
export function checkQueries(g: Ontology): Finding[] {
  const { get } = index(g);
  const findings: Finding[] = [];
  for (const q of g.nodes.filter((n) => n.kind === 'query')) {
```

## 怎么修

SQL 引用 reads 对应的 safe 视图，用命名参数绑定输入。

## 正例

```text
reads: [PurchaseOrder], sql: 'select amount from safe.purchase_order where status = :status'
```

## 反例

```text
sql: 'select * from core.purchase_order'
```
