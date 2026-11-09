# CAGE-STATE-001：引用了未声明状态

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

command.from/to 或 states.initial/terminal 包含状态集合中不存在的值。

## 修复步骤

1. 检查拼写并在同一状态集中声明；new 是创建命令来源，不是需要放进 states 的普通状态。

## 正例

```text
states('draft', 'done', { terminal: ['done'] })；to: 'done'
```

## 反例

```text
to: 'finished'，状态集中只有 done
```

## 修复后验证

重跑 cage check、gen，审查状态图和相关状态迁移用例。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/command.ts:228`
- `packages/kernel/src/primitives/command.ts:236`
- `packages/kernel/src/primitives/states.ts:59`

实现片段（位置随框架版本更新）：

```ts
  if (from !== 'new' && !hasStates(agg, from)) {
    throw declError('CAGE-STATE-001', `${agg.name} 的命令 from 里有未声明的状态：${[from].flat().join(', ')}`);
  }
  // 回执等异步元数据可能在单据取消/完成后到达。允许显式保留当前状态，
  // 避免业务 handler 通过篡改 status 绕过状态机；新建命令必须有实际目标状态。
```
