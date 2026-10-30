# CAGE-APPR-004

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/approval/src/bridge.ts:8](../../packages/approval/src/bridge.ts)

```ts
  const binding = k.registry.approvalByProcess(r.process);
  if (!binding) throw new Error(`[CAGE-APPR-004] 没有流程 ${r.process} 的审批绑定`);
  const cmd = r.outcome === 'approved' ? binding.a.onApproved : binding.a.onRejected;
  const ctx = k.processCtx({
    process: r.process,
    tenantId: r.tenantId,
```

## 怎么修

核对流程绑定、可路由字段、结论命令及审批人配置。结论只能调用所属聚合的 process 命令。

## 正例

```text
onApproved: approve // approve 声明 invokedBy: 'process'
```

## 反例

```text
onApproved: otherAggregateCommand // 结论落到了错误聚合
```
