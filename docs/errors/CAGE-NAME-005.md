# CAGE-NAME-005

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/flow.ts:88](../../packages/kernel/src/primitives/flow.ts)

```ts
): Query<I> {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-005', `查询名 ${name} 必须是小驼峰`);
  if (!def.sql === !def.build) throw declError('CAGE-QUERY-001', `查询 ${name} 必须二选一：sql 或 build`);
  if (def.sql && /\bcore\.|\bsys\./i.test(def.sql)) {
    throw declError('CAGE-QUERY-002', `查询 ${name} 引用了基表，只能引用 safe.* 安全视图`);
  }
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
