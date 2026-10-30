# CAGE-PAIR-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:43](../../packages/cli/src/rules.ts)

```ts

/** CAGE-PAIR-002：进入某状态时获得了资源，从该状态出发的每一条迁移都必须释放它，或进入一个同样持有它的状态 */
export function checkPairing(g: Ontology): Finding[] {
  const { get } = index(g);
  const findings: Finding[] = [];
  const held = statesHoldingResources(g);
```

## 怎么修

离开持有资源的状态时，发出事件并声明释放该资源的反应；检查每一条离开路径。

## 正例

```text
reaction(OrderCancelled, { command: releaseLock, releases: 'inventory.lock', map: e => ({ id: e.orderId }) });
```

## 反例

```text
// approved 持有 inventory.lock，取消却没有 releases 反应
command(PurchaseOrder, { from: 'approved', to: 'cancelled', handler: o => o });
```
