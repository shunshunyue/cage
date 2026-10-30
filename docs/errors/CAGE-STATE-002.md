# CAGE-STATE-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/states.ts:22](../../packages/kernel/src/primitives/states.ts)

```ts
  const values = all.filter((a): a is S => typeof a === 'string');
  if (values.length === 0) throw declError('CAGE-STATE-002', 'states() 至少需要一个状态');
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) throw declError('CAGE-STATE-003', `状态名 ${v} 必须是小写下划线`);
  }
  if (new Set(values).size !== values.length) throw declError('CAGE-STATE-004', '状态名重复');
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
