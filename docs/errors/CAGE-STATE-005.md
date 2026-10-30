# CAGE-STATE-005

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/aggregate.ts:78](../../packages/kernel/src/primitives/aggregate.ts)

```ts
    if (isStates(v)) {
      if (k !== 'status') throw declError('CAGE-STATE-005', `状态集只能放在 status 字段上（发现 ${name}.${k}）`);
      if (st) throw declError('CAGE-STATE-005', `${name} 同时在 states 和 fields.status 里声明了状态`);
      st = v;
      continue;
    }
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
