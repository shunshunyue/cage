# CAGE-STATE-003：状态名称格式错误

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

状态名称不是小写字母开头的小写下划线格式。

## 修复步骤

1. 状态标识使用 pending_approval 等，中文名称通过页面/graph.labels 显示。

## 正例

```text
states('draft', 'pending_approval', 'done')
```

## 反例

```text
states('PendingApproval', '已完成')
```

## 修复后验证

重跑 cage check、gen，审查状态图和相关状态迁移用例。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/states.ts:25`

实现片段（位置随框架版本更新）：

```ts
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) throw declError('CAGE-STATE-003', `状态名 ${v} 必须是小写下划线`);
  }
  if (new Set(values).size !== values.length) throw declError('CAGE-STATE-004', '状态名重复');
  const terminal = opts.terminal ?? [];
```
