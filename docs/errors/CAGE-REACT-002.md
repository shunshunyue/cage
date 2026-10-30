# CAGE-REACT-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/kernel.ts:193](../../packages/kernel/src/kernel.ts)

```ts
    const agg = cmd.agg;
    if (depth > this.maxDepth) throw new Error(`[CAGE-REACT-002] 同事务反应嵌套超过 ${this.maxDepth} 层`);

    // 第 1 关：认证
    if (!ctx.actor || (ctx.actor.kind === 'anonymous' && !cmd.public)) throw cageError('UNAUTHENTICATED');

```

## 怎么修

反应的目标聚合必须与 command 一致，目标命令需从统一入口导出。

## 正例

```text
reaction(Approved, { command: acquireLock, map: e => ({ id: e.orderId }) })
```

## 反例

```text
reaction(Approved, { target: Order, command: acquireLock, map })
```
