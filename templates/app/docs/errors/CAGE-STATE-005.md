# CAGE-STATE-005：状态声明位置冲突

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

状态集放在 fields 非 status 键，或同时通过 aggregate.states 与 fields.status 定义。

## 修复步骤

1. 只选择一种位置：推荐 aggregate.states，fields 中不再重复。

## 正例

```text
fields: { amount: money() }, states: POStatus
```

## 反例

```text
fields: { stage: POStatus }，或 states 与 fields.status 同时提供
```

## 修复后验证

重跑 cage check、gen，审查状态图和相关状态迁移用例。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/aggregate.ts:169`
- `packages/kernel/src/primitives/aggregate.ts:170`
- `packages/kernel/src/primitives/states.ts:62`

实现片段（位置随框架版本更新）：

```ts
    if (isStates(v)) {
      if (k !== 'status') throw declError('CAGE-STATE-005', `状态集只能放在 status 字段上（发现 ${name}.${k}）`);
      if (st) throw declError('CAGE-STATE-005', `${name} 同时在 states 和 fields.status 里声明了状态`);
      st = v;
      continue;
```
