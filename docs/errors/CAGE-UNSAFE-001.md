# CAGE-UNSAFE-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/flow.ts:219](../../packages/kernel/src/primitives/flow.ts)

```ts
export function unsafe<T>(tag: UnsafeTag, fn: () => T): T {
  if (!tag?.reason || !tag?.owner) throw declError('CAGE-UNSAFE-001', 'unsafe 必须写明 reason 和 owner');
  return fn();
}
(unsafe as any)[UNSAFE] = true;

```

## 怎么修

优先改为声明或命令；确需逃生口时填写非空 reason、owner，并记录评审。

## 正例

```text
unsafe({ reason: '一次性修复历史数据', owner: '数据负责人' }, action)
```

## 反例

```text
unsafe({ reason: '', owner: '' }, action)
```
