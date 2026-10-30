# CAGE-SQL-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/lint/src/rules/no-sql-concat.ts:19](../../packages/lint/src/rules/no-sql-concat.ts)

```ts
    messages: {
      concat: '[CAGE-SQL-001] 不要拼接 SQL 字符串，改用 sql 标签模板或查询构建器（值会自动参数化）',
      raw: '[CAGE-SQL-002] sql.raw() 只能接收字面量',
    },
    schema: [],
  },
```

## 怎么修

使用参数化 SQL 或查询构建器；sql.raw 只接收固定 SQL 片段。

## 正例

```text
sql`select * from safe.purchase_order where id = ${id}`
```

## 反例

```text
'select * from safe.purchase_order where id = ' + input
```
