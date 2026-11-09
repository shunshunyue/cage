# CAGE-SQL-001：SQL 拼接用户值

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：lint。

lint 发现 SQL 字符串拼接或插值存在注入风险。

## 修复步骤

1. query.sql 使用 :name 命名参数；受支持的 Kysely 构建器绑定值。不要用替换引号等手工转义替代参数化。

## 正例

```text
sql: 'select id from safe.purchase_order where status = :status'
```

## 反例

```text
'select id from safe.purchase_order where status = ' + input.status
```

## 修复后验证

重跑相关 lint/verify，并用正常及特殊字符输入验证参数语义。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/src/rules/no-sql-concat.ts:32`

实现片段（位置随框架版本更新）：

```ts
    messages: {
      concat: '[CAGE-SQL-001] 不要拼接 SQL 字符串，改用 sql 标签模板或查询构建器（值会自动参数化）',
      raw: '[CAGE-SQL-002] sql.raw() 只能接收字面量',
    },
    schema: [],
```
