# CAGE-REACT-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/flow.ts:46](../../packages/kernel/src/primitives/flow.ts)

```ts
  if (def.target && def.target !== def.command.agg) {
    throw declError('CAGE-REACT-001', `反应的 target 与 command 所属聚合不一致`);
  }
  return Object.freeze({
    [REACTION]: true as const,
    event: ev,
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
