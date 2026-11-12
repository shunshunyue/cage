# CAGE-REACT-001：反应目标与命令聚合不一致

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明 / 写流水线。

reaction 显式 target 与 command.agg 不同。

## 修复步骤

1. 省略 target 由框架从命令推导；确需写出时必须是命令所属聚合。

## 正例

```text
reaction(OrderApproved, { command: acquireLock, map })
```

## 反例

```text
target: PurchaseOrder，command 却属于 InventoryLock
```

## 修复后验证

重跑 cage check；同事务链验证共同提交/回滚，异步链检查 worker 和死信。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:87`

实现片段（位置随框架版本更新）：

```ts
  if (def.target && def.target !== def.command.agg) {
    throw declError('CAGE-REACT-001', `反应的 target 与 command 所属聚合不一致`);
  }
  if (def.order !== undefined && (!Number.isSafeInteger(def.order) || def.order < 0)) {
    throw declError('CAGE-REACT-003', '反应 order 必须为非负安全整数');
```

</details>
