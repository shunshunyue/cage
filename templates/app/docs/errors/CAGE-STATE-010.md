# CAGE-STATE-010：状态不可达

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

图规则从创建/初始状态沿声明的迁移无法到达某状态。

## 修复步骤

1. 补真实进入路径或移除无用状态，确保命令从入口导出；不要用不可调用的假命令连线。

## 正例

```text
draft 经 submit 到 pending_approval，再经 approve 到 approved
```

## 反例

```text
states 包含 received，却没有任何命令迁移到它
```

## 修复后验证

重跑 cage check、gen，审查状态图和相关状态迁移用例。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:92`
- `packages/cli/src/rules.ts:123`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-STATE-010：每个状态都能从初始状态到达；CAGE-STATE-011：非终态必须有出边 */
/**
 * 从新建或初始状态计算可达性，并检查非终态出边。
 * @param g 当前图。
```
