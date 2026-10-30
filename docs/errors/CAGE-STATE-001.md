# CAGE-STATE-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/command.ts:130](../../packages/kernel/src/primitives/command.ts)

```ts
  if (from !== 'new' && !hasStates(agg, from)) {
    throw declError('CAGE-STATE-001', `${agg.name} 的命令 from 里有未声明的状态：${[from].flat().join(', ')}`);
  }
  // 回执等异步元数据可能在单据取消/完成后到达。允许显式保留当前状态，
  // 避免业务 handler 通过篡改 status 绕过状态机；新建命令必须有实际目标状态。
  if (from === 'new' && def.to === null) {
```

## 怎么修

让 from/to 引用已声明的状态，初始状态可达，非终态有出边，结束状态列入 terminal。

## 正例

```text
states('draft', 'done', { terminal: ['done'] });
```

## 反例

```text
command(Order, { from: 'missing', to: 'done', handler: o => o });
```
