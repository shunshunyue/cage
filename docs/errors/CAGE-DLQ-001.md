# CAGE-DLQ-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/worker/outbox.ts:128](../../packages/kernel/src/worker/outbox.ts)

```ts
    const d = await tx.selectFrom('sys.dead_letter').selectAll().where('id', '=', deadLetterId).where('handled_at', 'is', null).forUpdate().executeTakeFirst();
    if (!d) throw new Error('[CAGE-DLQ-001] 死信不存在或已处理');
    await tx.updateTable('sys.outbox').set({ status: 'pending', attempts: 0, next_at: sql`now()`, last_error: null }).where('id', '=', d.outbox_id).execute();
    await tx.updateTable('sys.dead_letter').set({ handled_by: handledBy, handled_at: sql`now()`, resolution: 'replayed' }).where('id', '=', deadLetterId).execute();
    await sql`select pg_notify('cage_outbox', '')`.execute(tx);
  });
```

## 怎么修

检查死信详情和事件顺序，修复原因后用管理接口重放或丢弃，不直接改业务表。

## 正例

```text
在 /admin 的死信列表检查错误并重放
```

## 反例

```text
直接更新 sys.outbox 绕过死信处理流程
```
