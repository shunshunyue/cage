# CAGE-QUERY-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/flow.ts:89](../../packages/kernel/src/primitives/flow.ts)

```ts
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-005', `查询名 ${name} 必须是小驼峰`);
  if (!def.sql === !def.build) throw declError('CAGE-QUERY-001', `查询 ${name} 必须二选一：sql 或 build`);
  if (def.sql && /\bcore\.|\bsys\./i.test(def.sql)) {
    throw declError('CAGE-QUERY-002', `查询 ${name} 引用了基表，只能引用 safe.* 安全视图`);
  }
  return Object.freeze({
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
