# CAGE-APPR-004：路由没有对应审批绑定

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

运行审批桥接时，route 的 process 找不到同名 approval 绑定。

## 修复步骤

1. 检查 process 名完全相同，绑定和路由均从 domain 入口导出。

## 正例

```text
approval(..., { process: 'po-approval', ... }) 与 route('po-approval', ...)
```

## 反例

```text
绑定叫 po-approval，路由叫 purchase-approval
```

## 修复后验证

先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/approval/src/bridge.ts:14`

实现片段（位置随框架版本更新）：

```ts
  const binding = k.registry.approvalByProcess(r.process);
  if (!binding) throw new Error(`[CAGE-APPR-004] 没有流程 ${r.process} 的审批绑定`);
  const cmd = r.outcome === 'approved' ? binding.a.onApproved : r.outcome === 'returned' ? binding.a.onReturned : binding.a.onRejected;
  if (!cmd) throw new Error('[CAGE-APPR-006] 审批未绑定退回修改命令');
  let ctx: Ctx;
```
