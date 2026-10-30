# CAGE-NAME-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/event.ts:19](../../packages/kernel/src/primitives/event.ts)

```ts
export function event<const N extends string, F extends Fields>(name: N, fields: F, opts?: { description?: string }): Event<N, F> {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-003', `事件名 ${name} 必须是大驼峰`);
  return Object.freeze({
    [EVENT]: true as const,
    name,
    fields: Object.freeze({ ...fields }),
```

## 怎么修

聚合、事件使用大驼峰；命令、任务和查询使用小驼峰，且同类名称唯一。

## 正例

```text
aggregate('PurchaseOrder', definition);
```

## 反例

```text
aggregate('purchase-order', definition);
```
