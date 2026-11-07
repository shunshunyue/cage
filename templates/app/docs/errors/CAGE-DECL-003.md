# CAGE-DECL-003：声明不是 export const

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：静态检查 / 注册。

顶层声明没有同时使用 export 和 const。

## 修复步骤

1. 使用稳定的模块顶层 export const；不要用可变声明或只保留文件内私有声明。

## 正例

```text
export const OrderSubmitted = event('OrderSubmitted', fields)
```

## 反例

```text
const OrderSubmitted = event('OrderSubmitted', fields)
```

## 修复后验证

重跑 cage check/analyze，确认声明出现在本体图，再运行 gen。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/static-check.ts:210`

实现片段（位置随框架版本更新）：

```ts
                findings.push({
                  code: 'CAGE-DECL-003',
                  at: loc(node),
                  reason: `声明 ${topDecl.name.getText()} 没有用 export const 导出`,
                  fix: '加上 export const，并确认它从 domain 的 index.ts 导出',
```
