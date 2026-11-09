# CAGE-REG-002：聚合或查询注册重名

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载 / 执行。

同类聚合/查询拥有相同逻辑名称。

## 修复步骤

1. 保留一个规范声明，或为真正不同对象选不同逻辑名；不能通过对象复制创建同名注册。

## 正例

```text
aggregate('PurchaseOrder', ...)、aggregate('Inventory', ...)
```

## 反例

```text
不同文件都 aggregate('Order', ...) 并导出
```

## 修复后验证

重跑 cage check/analyze/gen，确认统一入口包含引用双方。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/registry.ts:134`
- `packages/kernel/src/registry.ts:176`
- `packages/kernel/src/registry.ts:242`

实现片段（位置随框架版本更新）：

```ts
          if (aggregates.some((a) => a.name === (v as AnyAggregate).name)) {
            throw declError('CAGE-REG-002', `聚合名重复：${(v as AnyAggregate).name}`);
          }
          aggregates.push(v as AnyAggregate);
          break;
```
