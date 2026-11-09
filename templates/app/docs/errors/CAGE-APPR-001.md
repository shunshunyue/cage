# CAGE-APPR-001：审批字段声明无效

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

approval.routable 引用了不存在字段，或 approver.field 指向未声明、隐藏、未进入 routable 的字段。

## 修复步骤

1. 先在聚合声明实际字段，再将需要给审批路由的非隐藏字段放入 routable；不要把任意输入直接交给流程。
2. 字段选人值应为 UUID 或非空 UUID 数组，见 docs/ai/approvals.md；字段公开并不自动授予审批能力。

## 正例

```text
routable: ['amount', 'deptId'] // 两字段均在 PurchaseOrder.fields 中
```

## 反例

```text
routable: ['managerName'] // 聚合没有该字段
```

## 修复后验证

先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/approval/src/route.ts:215`
- `packages/approval/src/route.ts:220`
- `packages/approval/src/route.ts:229`
- `packages/kernel/src/primitives/flow.ts:245`

实现片段（位置随框架版本更新）：

```ts
      if (reminders && (!routeBinding?.routable.includes(reminders.requesterField) || !routeBinding.agg.fields[reminders.requesterField] || routeBinding.agg.fields[reminders.requesterField].isHidden))
        throw declError('CAGE-APPR-001', `申请人字段 ${reminders.requesterField} 必须存在、可公开且进入 routable`);
      for (const node of declaredSteps) {
        const selector = node.kind === 'ai' ? node.handoff : node.approver;
        // 新字段选择器必须能从 routable 快照取值；不追溯改变历史部门选人的声明校验行为。
```
