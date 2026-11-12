# CAGE-REACT-003：集合或步骤顺序声明无效

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明 / 写流水线。

reactionEach 没有正整数上限或排序字段，order 非法，或同事件同事务分组混用有序/无序步骤、顺序重复。

## 修复步骤

1. 为集合声明 maxItems、orderBy、items 和 map；排序键必须稳定、非空且唯一。
2. 同事件同 tx 分组需要显式顺序时，为全部步骤声明不同的非负整数 order；锁资源按稳定键串行处理。

## 正例

```text
reactionEach(Allocated, { command: acquire, items: e => e.assets, maxItems: 20, orderBy: 'assetId', order: 20, tx: 'same', map: item => ({ id: item.assetId }) })
```

## 反例

```text
同事件同事务一条 order: 10、另一条没有 order，或两个步骤都 order: 10
```

## 修复后验证

重跑 cage check；同事务链验证共同提交/回滚，异步链检查 worker 和死信。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/collection.ts:68`
- `packages/kernel/src/primitives/flow.ts:90`
- `packages/kernel/src/registry.ts:230`

实现片段（位置随框架版本更新）：

```ts
  if (!Number.isSafeInteger(def.maxItems) || def.maxItems < 1 || !def.orderBy) {
    throw declError('CAGE-REACT-003', '集合反应必须声明正整数 maxItems 和非空 orderBy 字段');
  }
  const base = reaction(event, { ...def, map: () => null });
  const expand = (payload: PayloadOf<E>): ReactionEntry<z.input<C['input']>>[] => {
```

</details>
