# CAGE-EVENT-002：事件变更不向后兼容

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：写事务 / 基线比较。

与基线相比，删除旧载荷字段、改变字段 kind，或新增必填字段。

## 修复步骤

1. 保留旧字段和类型，新字段 optional；不兼容含义新建事件，并考虑旧 outbox 消息和消费者升级顺序。

## 正例

```text
note: text().optional() // 新增字段
```

## 反例

```text
给线上已有事件新增必填 note，旧消息没有该值
```

## 修复后验证

运行相关命令与消费者测试；兼容性使用修改前基线检查，考虑尚未消费的旧事件。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:226`
- `packages/cli/src/rules.ts:238`
- `packages/cli/src/rules.ts:245`
- `packages/cli/src/rules.ts:255`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-EVENT-002：事件载荷只允许向后兼容的变更（只能新增可选字段） */
export function checkEventCompat(base: Ontology, head: Ontology): Finding[] {
  const findings: Finding[] = [];
  const b = new Map(base.nodes.filter((n) => n.kind === 'event').map((n) => [n.id, n]));
```
