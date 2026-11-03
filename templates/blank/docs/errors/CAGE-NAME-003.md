# CAGE-NAME-003：事件名必须大驼峰

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

event 名称格式不满足大驼峰。

## 修复步骤

1. 使用表示已发生事实的稳定大驼峰事件名，避免中文或短横线标识。

## 正例

```text
event('OrderSubmitted', fields)
```

## 反例

```text
event('order-submitted', fields)
```

## 修复后验证

重跑 cage check/gen；改动线上标识时还要审查能力、路由、迁移及旧消费者影响。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/event.ts:19`

实现片段（位置随框架版本更新）：

```ts
export function event<const N extends string, F extends Fields>(name: N, fields: F, opts?: { description?: string }): Event<N, F> {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-003', `事件名 ${name} 必须是大驼峰`);
  if (Object.values(fields).some(isRelation)) throw declError('CAGE-REL-001', '事件载荷不声明持久化关系；传递 ID 数组请使用 list(id())');
  if (Object.values(fields).some(isFile)) throw declError('CAGE-FILE-001', '事件传递文件 ID 请使用 id/list(id())，不声明文件生命周期');
  return Object.freeze({
```
