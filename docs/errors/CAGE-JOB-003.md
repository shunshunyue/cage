# CAGE-JOB-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/worker/scheduler.ts:28](../../packages/kernel/src/worker/scheduler.ts)

```ts
      async list(agg, where = {}, opts = {}) {
        if (!allowedReads.has(agg)) throw new Error(`[CAGE-JOB-003] 任务 ${j.name} 读取了未声明的聚合 ${agg.name}`);
        const { createdBefore, createdAfter, updatedBefore, ...eq } = where as Record<string, any>;
        let q = scopedFind(k.app, agg, ctx, eq, { limit: opts.limit ?? 1000 });
        if (createdBefore) q = q.where('t.created_at', '<', new Date(createdBefore));
        if (createdAfter) q = q.where('t.created_at', '>=', new Date(createdAfter));
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
