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

- `packages/approval/src/route.ts:97`

实现片段（位置随框架版本更新）：

```ts
  if (!/^[a-z][a-z0-9-]*$/.test(process)) throw declError('CAGE-APPR-005', `流程名 ${process} 必须是小写短横线`);
  if (nodes.length === 0) throw declError('CAGE-APPR-006', `流程 ${process} 至少需要一个步骤`);
  const fields = new Set<string>();
  for (const n of nodes) {
    const steps = n.kind === 'step' ? [n] : n.steps;
```
