# CAGE-APPR-006：审批步骤配置无效

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明、图规则或 worker。

route 没有步骤、展开后为空，或人工 actions/assignment、候选池与 all 组合、AI 步骤必填配置或预算不合法。

## 修复步骤

1. 声明至少一个实际审批步骤，并检查条件后能否形成预期流程。
2. candidate 只支持 any；逐人会签用默认 direct。actions 只接受 transfer/delegate/addSign 布尔值。
3. AI 步骤需模型、要求、上下文字段、接管规则及正整数预算，并绑定 AI 运行时、退回命令和自动角色。

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

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/approval/src/bridge.ts:16`
- `packages/approval/src/deadlines.ts:34`
- `packages/approval/src/deadlines.ts:41`
- `packages/approval/src/engine.ts:75`
- `packages/approval/src/execution.ts:40`
- `packages/approval/src/execution.ts:42`
- `packages/approval/src/execution.ts:47`
- `packages/approval/src/execution.ts:49`
- `packages/approval/src/execution.ts:54`
- `packages/approval/src/execution.ts:55`
- `packages/approval/src/execution.ts:88`
- `packages/approval/src/operations.ts:375`
- `packages/approval/src/route.ts:109`
- `packages/approval/src/route.ts:111`
- `packages/approval/src/route.ts:115`
- `packages/approval/src/route.ts:117`
- `packages/approval/src/route.ts:177`
- `packages/approval/src/route.ts:213`
- `packages/approval/src/route.ts:224`
- `packages/approval/src/route.ts:226`

实现片段（位置随框架版本更新）：

```ts
  const cmd = r.outcome === 'approved' ? binding.a.onApproved : r.outcome === 'returned' ? binding.a.onReturned : binding.a.onRejected;
  if (!cmd) throw new Error('[CAGE-APPR-006] 审批未绑定退回修改命令');
  let ctx: Ctx;
  if (r.lastApprover) {
    // 待办决定已持有事务连接时复用它；同实例并发排队不能耗尽池后让锁持有者再等新连接。
```

</details>
