# CAGE-SYNC-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/sync.ts:25](../../packages/cli/src/sync.ts)

```ts
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index! < starts[0].index!) {
    throw new Error('[CAGE-SYNC-001] 托管区标记不完整或重复，请修复 AGENTS.md 的 begin/end 标记');
  }
  return current.slice(0, starts[0].index) + latest + current.slice(ends[0].index! + ends[0][0].length);
}

```

## 怎么修

修复唯一的 begin/end 标记，再执行 cage sync；托管区之外的内容会保留。

## 正例

```text
<!-- cage:begin v0.1.0 -->
框架约定
<!-- cage:end -->
```

## 反例

```text
<!-- cage:begin old -->
没有结束标记
```
