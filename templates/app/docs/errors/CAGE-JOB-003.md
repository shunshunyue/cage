# CAGE-JOB-003：任务读取了未声明的聚合

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / worker。

job.run 的 query.list 读取目标不在 reads 中。

## 修复步骤

1. 在 job.reads 列出实际读取聚合并从入口导出；保留可追踪的读依赖。

## 正例

```text
reads: [PurchaseOrder]，query.list(PurchaseOrder, ...)
```

## 反例

```text
reads: []，却 query.list(PurchaseOrder, ...)
```

## 修复后验证

先 cage check，再在独立测试环境用目标任务数据验证读取、调用与审计；不要等待生产定时器试错。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/worker/scheduler.ts:33`

实现片段（位置随框架版本更新）：

```ts
      async list(agg, where = {}, opts = {}) {
        if (!allowedReads.has(agg)) throw new Error(`[CAGE-JOB-003] 任务 ${j.name} 读取了未声明的聚合 ${agg.name}`);
        const { createdBefore, createdAfter, updatedBefore, ...eq } = where as Record<string, any>;
        let q = scopedFind(k.app, agg, ctx, eq, { limit: opts.limit ?? 1000 });
        if (createdBefore) q = q.where('t.created_at', '<', new Date(createdBefore));
```
