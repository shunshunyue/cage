# CAGE-APPR-002：审批结论落到其他聚合

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明、图规则或 worker。

onApproved 或 onRejected 的命令不属于当前审批绑定的聚合。

## 修复步骤

1. 把结论绑定到当前单据的命令；后续跨对象动作通过该命令的事件和反应完成。

## 正例

```text
PurchaseOrder 的审批绑定使用 approvePurchaseOrder 命令
```

## 反例

```text
采购审批 onApproved 直接绑定 InventoryLock.acquire
```

## 修复后验证

先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:248`

实现片段（位置随框架版本更新）：

```ts
  for (const c of [def.onApproved, def.onRejected, ...(def.onReturned ? [def.onReturned] : [])]) {
    if (c.agg !== agg) throw declError('CAGE-APPR-002', `审批结论命令必须属于 ${agg.name}`);
    if (!c.invokedBy.includes('process')) {
      throw declError('CAGE-APPR-003', `审批结论命令必须声明 invokedBy: 'process'`);
    }
```

</details>
