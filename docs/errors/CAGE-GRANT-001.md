# CAGE-GRANT-001：授予超出自己的能力或额度

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：组织命令。

管理员授予自己没有的能力/更高参数，或分配含越权能力的角色。

## 修复步骤

1. 由具备足够能力和参数的管理员操作；降低授予范围到自身权限内，不禁用防提权约束。

## 正例

```text
有 approve=100000 额度的管理员授予不超过自身的额度
```

## 反例

```text
自己没有采购审批能力，却给别人分配该能力或包含它的角色
```

## 修复后验证

用真实操作人验证允许与拒绝场景，检查目标角色最终能力、参数和范围。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/admin/src/domain/constraints.ts:21`
- `packages/admin/src/domain/constraints.ts:24`
- `packages/admin/src/domain/constraints.ts:51`

实现片段（位置随框架版本更新）：

```ts
    const mine = ctx.capabilities.get(input.capability);
    if (!mine) return violation('[CAGE-GRANT-001] 不能授出自己没有的能力点');
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (typeof v === 'number' && typeof mine[k] === 'number' && v > (mine[k] as number)) {
        return violation(`[CAGE-GRANT-001] 参数 ${k}=${v} 超过了你自己的 ${mine[k]}`);
```
