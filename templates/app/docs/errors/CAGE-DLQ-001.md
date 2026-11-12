# CAGE-DLQ-001：死信不存在或已经处理

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：系统管理接口。

重放/丢弃时目标死信已被处理或不在待处理集合。

## 修复步骤

1. 刷新死信列表，核对 outboxId 和审计记录；确认是否已由其他人处理，不直接重建/修改系统行。

## 正例

```text
查看当前状态后只处理待处理的死信
```

## 反例

```text
反复提交旧页面上的重放请求或手改 sys.outbox
```

## 修复后验证

刷新死信列表并查看审计及当前处理结果；核对原始 outboxId。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/worker/outbox.ts:169`
- `packages/kernel/src/worker/outbox.ts:181`

实现片段（位置随框架版本更新）：

```ts
    const d = await tx.selectFrom('sys.dead_letter').selectAll().where('id', '=', deadLetterId).where('handled_at', 'is', null).forUpdate().executeTakeFirst();
    if (!d) throw new Error('[CAGE-DLQ-001] 死信不存在或已处理');
    await tx.updateTable('sys.outbox').set({ status: 'pending', attempts: 0, next_at: sql`now()`, last_error: null }).where('id', '=', d.outbox_id).execute();
    await tx.updateTable('sys.dead_letter').set({ handled_by: handledBy, handled_at: sql`now()`, resolution: 'replayed' }).where('id', '=', deadLetterId).execute();
    await sql`select pg_notify('cage_outbox', '')`.execute(tx);
```

</details>
