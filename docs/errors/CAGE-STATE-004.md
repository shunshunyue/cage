# CAGE-STATE-004

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/states.ts:26](../../packages/kernel/src/primitives/states.ts)

```ts
  }
  if (new Set(values).size !== values.length) throw declError('CAGE-STATE-004', '状态名重复');
  const terminal = opts.terminal ?? [];
  for (const t of [...terminal, ...(opts.initial ? [opts.initial] : [])]) {
    if (!values.includes(t)) throw declError('CAGE-STATE-001', `状态 ${t} 未在 states 中声明`);
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
