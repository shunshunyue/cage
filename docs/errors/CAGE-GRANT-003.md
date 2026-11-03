# CAGE-GRANT-003：能力不在代码目录中

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：组织命令。

授权请求引用了注册表没有声明的能力点。

## 修复步骤

1. 先在 domain 声明并导出相应命令/聚合，再查看能力目录；不要在管理页面凭空发明能力名称。

## 正例

```text
PurchaseOrder.submit // 由已导出的命令形成
```

## 反例

```text
PurchaseOrder.anything // 没有对应声明
```

## 修复后验证

用真实操作人验证允许与拒绝场景，检查目标角色最终能力、参数和范围。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/admin/src/domain/constraints.ts:13`

实现片段（位置随框架版本更新）：

```ts
  check: (_role, _ctx, input, meta) =>
    meta.catalog().includes(input.capability) ? ok() : violation(`[CAGE-GRANT-003] 能力点 ${input.capability} 不在能力目录里`),
});

/** 防提权：不能授出自己没有的能力点；数值参数（额度）不能超过自己的 */
```
