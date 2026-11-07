# CAGE-EVENT-001：事件载荷不满足声明

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：写事务 / 基线比较。

命令要写入 outbox 的载荷没有通过事件字段 schema。

## 修复步骤

1. 核对默认载荷映射及字段类型；需要旧状态、改名字段或复杂数据时使用 emit 显式映射。事务失败应回滚，不单独补写消息。

## 正例

```text
emit(OrderCancelled, (o, _i, prev) => ({ orderId: o.id, previousStatus: prev.status }))
```

## 反例

```text
事件要求 orderId，却从错误字段映射成 undefined
```

## 修复后验证

运行相关命令与消费者测试；兼容性使用修改前基线检查，考虑尚未消费的旧事件。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/kernel.ts:398`

实现片段（位置随框架版本更新）：

```ts
      if (!p.success) {
        throw new Error(`[CAGE-EVENT-001] 事件 ${ev.name} 的载荷不符合声明：${JSON.stringify(zodIssues(p.error))}`);
      }
      const payload = maskEventPayload(ev, p.data as Record<string, unknown>);
      const row = await tx
```
