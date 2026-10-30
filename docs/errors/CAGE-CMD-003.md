# CAGE-CMD-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/command.ts:135](../../packages/kernel/src/primitives/command.ts)

```ts
  if (from === 'new' && def.to === null) {
    throw declError('CAGE-CMD-003', `${agg.name} 的新建命令必须指定目标状态，不能使用 to: null`);
  }
  if (def.to !== null && !hasStates(agg, def.to as string)) {
    throw declError('CAGE-STATE-001', `${agg.name} 的命令 to 是未声明的状态：${String(def.to)}`);
  }
```

## 怎么修

新建命令必须指定聚合中声明的目标状态。to: null 仅用于已有记录的字段更新；它保留加锁读出的状态，不跳过 from、权限、版本及审计检查。

## 正例

```text
command(Order, { from: 'new', to: 'draft', handler: o => o });
// 晚到回执可以保留终态
command(Order, { from: ['approved', 'cancelled'], to: null, handler: o => o });
```

## 反例

```text
command(Order, { from: 'new', to: null, handler: o => o }); // 新记录没有可保留的状态
```
