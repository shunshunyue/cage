# CAGE-QUERY-003：查询读取范围与声明不一致

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

SQL 引用了 reads 未声明聚合的 safe 视图，或引用非 safe 的限定表。

## 修复步骤

1. 在 reads 列出每个实际读取的聚合，并只查询相应安全视图；join 同样要声明。

## 正例

```text
reads: [PurchaseOrder]；SQL from safe.purchase_order
```

## 反例

```text
reads: []；SQL from safe.purchase_order
```

## 修复后验证

重跑 cage check/gen；用普通用户验证查询参数、read 能力、范围和掩码。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:169`
- `packages/cli/src/rules.ts:184`
- `packages/cli/src/rules.ts:202`
- `packages/kernel/src/primitives/flow.ts:105`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-QUERY-003：手写 SQL 只能引用 reads 里聚合的安全视图 */
export function checkQueries(g: Ontology): Finding[] {
  const { get } = index(g);
  const findings: Finding[] = [];
```
