# CAGE-STATE-011：非终态没有后续操作

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

自定义非终态在图中没有出边，单据可能永久停住。

## 修复步骤

1. 若业务结束则列入 terminal；否则补真实可执行的后续命令。默认生命周期有框架特别处理，不能据此忽略自定义状态。

## 正例

```text
states('draft', 'done', { terminal: ['done'] })，draft 有提交路径
```

## 反例

```text
声明 pending_approval 非终态，却没有批准/驳回/取消
```

## 修复后验证

重跑 cage check、gen，审查状态图和相关状态迁移用例。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:92`
- `packages/cli/src/rules.ts:132`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-STATE-010：每个状态都能从初始状态到达；CAGE-STATE-011：非终态必须有出边 */
/**
 * 从新建或初始状态计算可达性，并检查非终态出边。
 * @param g 当前图。
```
