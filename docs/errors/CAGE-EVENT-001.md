# CAGE-EVENT-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/kernel.ts:365](../../packages/kernel/src/kernel.ts)

```ts
      if (!p.success) {
        throw new Error(`[CAGE-EVENT-001] 事件 ${ev.name} 的载荷不符合声明：${JSON.stringify(zodIssues(p.error))}`);
      }
      const payload = maskEventPayload(ev, p.data as Record<string, unknown>);
      const row = await tx
        .insertInto('sys.outbox')
```

## 怎么修

保留旧事件字段及类型，新加字段设为 optional；不兼容含义使用新事件名。

## 正例

```text
event("OrderChanged", { orderId: id(), note: text().optional() })
```

## 反例

```text
// 给已有事件新增必填 note，旧 outbox 消息无法提供它
```
