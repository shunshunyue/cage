# CAGE-STATE-002：状态集合为空

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

states 没有任何字符串状态。

## 修复步骤

1. 声明实际业务状态；无需自定义生命周期时可使用聚合默认状态，但写命令仍需声明。

## 正例

```text
states('active', 'archived', { terminal: ['archived'] })
```

## 反例

```text
states()
```

## 修复后验证

重跑 cage check、gen，审查状态图和相关状态迁移用例。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/states.ts:52`

实现片段（位置随框架版本更新）：

```ts
  const values = all.filter((a): a is S => typeof a === 'string');
  if (values.length === 0) throw declError('CAGE-STATE-002', 'states() 至少需要一个状态');
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) throw declError('CAGE-STATE-003', `状态名 ${v} 必须是小写下划线`);
  }
```
