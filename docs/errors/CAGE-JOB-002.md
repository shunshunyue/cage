# CAGE-JOB-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/worker/scheduler.ts:38](../../packages/kernel/src/worker/scheduler.ts)

```ts
    async call(cmd: AnyCommand, input: unknown) {
      if (!j.calls.includes(cmd)) throw cageError('FORBIDDEN', { message: `[CAGE-JOB-002] 任务 ${j.name} 调用了未声明的命令` });
      return (await k.execute(cmd, input, ctx)) as any;
    },
  };
}
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
