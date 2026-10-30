# CAGE-NAME-004

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/command.ts:145](../../packages/kernel/src/primitives/command.ts)

```ts
  if (def.name !== undefined && !/^[a-z][A-Za-z0-9]*$/.test(def.name)) {
    throw declError('CAGE-NAME-004', `命令名 ${def.name} 必须是小驼峰`);
  }
  return Object.freeze({
    [COMMAND]: true as const,
    agg,
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
