# CAGE-SQL-002：sql.raw 接收动态表达式

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：lint。

sql.raw 不是固定字面量，可能把输入当作 SQL 结构。

## 修复步骤

1. raw 仅使用固定 SQL 片段，动态值参数化，动态列/排序按声明白名单选择；不把完整用户输入塞到 raw。

## 正例

```text
sql.raw('count(*)') // 固定片段
```

## 反例

```text
sql.raw(input.orderBy)
```

## 修复后验证

重跑相关 lint/verify，并用正常及特殊字符输入验证参数语义。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/src/rules/no-sql-concat.ts:20`

实现片段（位置随框架版本更新）：

```ts
      concat: '[CAGE-SQL-001] 不要拼接 SQL 字符串，改用 sql 标签模板或查询构建器（值会自动参数化）',
      raw: '[CAGE-SQL-002] sql.raw() 只能接收字面量',
    },
    schema: [],
  },
```
