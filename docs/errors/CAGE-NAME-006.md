# CAGE-NAME-006

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/flow.ts:189](../../packages/kernel/src/primitives/flow.ts)

```ts
): Job {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-006', `任务名 ${name} 必须是小驼峰`);
  if (def.cron.trim().split(/\s+/).length < 5) throw declError('CAGE-JOB-001', `任务 ${name} 的 cron 表达式不合法`);
  return Object.freeze({
    [JOB]: true as const,
    name,
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
