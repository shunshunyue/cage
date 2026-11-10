# CAGE-QUERY-002：自定义查询直接访问基表

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 图规则。

query.sql 引用了 core.* 或 sys.*。

## 修复步骤

1. 改成对应 safe 视图，让只读账号落实范围与掩码。需要系统管理数据时使用框架已有系统接口，不绕过安全层。

## 正例

```text
'select amount from safe.purchase_order where status = :status'
```

## 反例

```text
'select * from core.purchase_order'
```

## 修复后验证

重跑 cage check/gen；用普通用户验证查询参数、read 能力、范围和掩码。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:168`

实现片段（位置随框架版本更新）：

```ts
  if (def.sql && /\bcore\.|\bsys\./i.test(def.sql)) {
    throw declError('CAGE-QUERY-002', `查询 ${name} 引用了基表，只能引用 safe.* 安全视图`);
  }
  if (def.audit && !def.audit.purpose.trim()) throw declError('CAGE-QUERY-003', `查询 ${name} 的审计 purpose 不能为空`);
  return Object.freeze({
```
