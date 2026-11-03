# CAGE-FIELD-003：字段不是字段原语

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

aggregate.fields 中存在不是 field/states 描述对象的值。

## 修复步骤

1. 使用 text/int/money/ref/list 等公开字段工厂；Zod 用在命令输入或 json schema，不能直接代替 fields 的字段描述。

## 正例

```text
fields: { amount: money() }
```

## 反例

```text
fields: { amount: z.string() }
```

## 修复后验证

重跑 cage check/gen，审查契约与迁移；敏感字段还要验证普通用户读结果。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/aggregate.ts:83`

实现片段（位置随框架版本更新）：

```ts
    }
    if (!isField(v)) throw declError('CAGE-FIELD-003', `${name}.${k} 不是字段原语`);
    if ((RESERVED_FIELDS as readonly string[]).includes(k)) {
      throw declError('CAGE-FIELD-004', `${name}.${k} 是保留字段名，由内核维护`);
    }
```
