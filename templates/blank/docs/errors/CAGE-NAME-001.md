# CAGE-NAME-001：聚合名必须大驼峰

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

aggregate 名称不是大写字母开头的字母数字标识。

## 修复步骤

1. 聚合使用稳定英文大驼峰，中文显示名写 description/graph.labels。

## 正例

```text
aggregate('PurchaseOrder', definition)
```

## 反例

```text
aggregate('purchase-order', definition)
```

## 修复后验证

重跑 cage check/gen；改动线上标识时还要审查能力、路由、迁移及旧消费者影响。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/aggregate.ts:163`

实现片段（位置随框架版本更新）：

```ts
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    throw declError('CAGE-NAME-001', `聚合名 ${name} 必须是大驼峰`);
  }
  let st: StatesDef<any> | undefined = def.states;
  const fields: Record<string, AnyField> = {};
```
