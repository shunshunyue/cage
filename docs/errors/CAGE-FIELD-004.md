# CAGE-FIELD-004：覆盖系统保留列

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

业务 fields 定义了 id/version/status/createdAt/updatedAt/tenantId 等保留字段。

## 修复步骤

1. 移除重复系统字段；状态使用 aggregate.states 或唯一 fields.status 状态声明；业务另取有意义名称。

## 正例

```text
fields: { externalId: text() }, states: POStatus
```

## 反例

```text
fields: { version: text() }
```

## 修复后验证

重跑 cage check/gen，审查契约与迁移；敏感字段还要验证普通用户读结果。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/aggregate.ts:176`

实现片段（位置随框架版本更新）：

```ts
    if ((RESERVED_FIELDS as readonly string[]).includes(k)) {
      throw declError('CAGE-FIELD-004', `${name}.${k} 是保留字段名，由内核维护`);
    }
    if (!/^[a-z][A-Za-z0-9]*$/.test(k)) throw declError('CAGE-NAME-002', `字段名 ${name}.${k} 必须是小驼峰`);
    fields[k] = v;
```
