# CAGE-QUERY-001：查询必须选择一种实现

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

query 同时提供或同时未提供 sql/build。

## 修复步骤

1. 在参数化手写 SQL 与查询构建器之间选择一种，显式声明 reads 和 input。

## 正例

```text
query('poByStatus', { reads: [PurchaseOrder], input, sql })
```

## 反例

```text
query('poByStatus', { reads: [PurchaseOrder], sql, build })
```

## 修复后验证

重跑 cage check/gen；用普通用户验证查询参数、read 能力、范围和掩码。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:101`

实现片段（位置随框架版本更新）：

```ts
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-005', `查询名 ${name} 必须是小驼峰`);
  if (!def.sql === !def.build) throw declError('CAGE-QUERY-001', `查询 ${name} 必须二选一：sql 或 build`);
  if (def.sql && /\bcore\.|\bsys\./i.test(def.sql)) {
    throw declError('CAGE-QUERY-002', `查询 ${name} 引用了基表，只能引用 safe.* 安全视图`);
  }
```
