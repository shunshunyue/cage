# CAGE-APPR-001：可路由字段不存在

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

approval.routable 引用了所属聚合没有声明的字段。

## 修复步骤

1. 先在聚合声明实际字段，再将需要给审批路由的字段放入 routable；不要把任意输入直接交给流程。

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

- `packages/kernel/src/primitives/flow.ts:148`

实现片段（位置随框架版本更新）：

```ts
  for (const f of def.routable) {
    if (!(f in agg.fields)) throw declError('CAGE-APPR-001', `可路由字段 ${agg.name}.${f} 不存在`);
  }
  for (const c of [def.onApproved, def.onRejected]) {
    if (c.agg !== agg) throw declError('CAGE-APPR-002', `审批结论命令必须属于 ${agg.name}`);
```
