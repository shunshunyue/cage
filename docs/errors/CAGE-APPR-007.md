# CAGE-APPR-007

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/approval/src/engine.ts:64](../../packages/approval/src/engine.ts)

```ts
    if (who.length === 0) {
      throw new Error(`[CAGE-APPR-007] 流程 ${this.route.process} 第 ${index + 1} 步「${s.title}」找不到审批人，请在 /admin 配置部门负责人或角色`);
    }
    for (const assignee of new Set(who)) {
      await tx.insertInto('flow.approval_task').values({ instance_id: instanceId, tenant_id: tenantId, step: index, title: s.title, assignee }).execute();
    }
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
