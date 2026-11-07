# CAGE-APPR-006：流程没有步骤

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

route 接收了空步骤数组。

## 修复步骤

1. 声明至少一个实际审批步骤，并检查条件后能否形成预期流程。

## 正例

```text
route('po-approval', [step('经理审批', approver.deptLeader('deptId'))])
```

## 反例

```text
route('po-approval', [])
```

## 修复后验证

先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/approval/src/bridge.ts:11`
- `packages/approval/src/engine.ts:63`
- `packages/approval/src/route.ts:57`
- `packages/approval/src/route.ts:59`
- `packages/approval/src/route.ts:110`
- `packages/approval/src/route.ts:137`
- `packages/approval/src/route.ts:139`

实现片段（位置随框架版本更新）：

```ts
  const cmd = r.outcome === 'approved' ? binding.a.onApproved : r.outcome === 'returned' ? binding.a.onReturned : binding.a.onRejected;
  if (!cmd) throw new Error('[CAGE-APPR-006] 审批未绑定退回修改命令');
  let ctx: Ctx;
  if (r.lastApprover) {
    const user = await k.contextFor(r.lastApprover, r.tenantId);
```
