# CAGE-JOB-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/flow.ts:190](../../packages/kernel/src/primitives/flow.ts)

```ts
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-006', `任务名 ${name} 必须是小驼峰`);
  if (def.cron.trim().split(/\s+/).length < 5) throw declError('CAGE-JOB-001', `任务 ${name} 的 cron 表达式不合法`);
  return Object.freeze({
    [JOB]: true as const,
    name,
    cron: def.cron,
```

## 怎么修

校正 cron、reads 和 calls。任务只能读取和调用显式声明的依赖。

## 正例

```text
job('expireOrders', { cron: '0 2 * * *', reads: [Order], calls: [cancel], run })
```

## 反例

```text
calls: [] // run 却调用 cancel
```
