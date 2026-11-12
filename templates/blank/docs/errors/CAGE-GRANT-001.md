# CAGE-GRANT-001：授予超出自己的能力或参数

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：组织命令。

管理员授予自己没有的能力/更高数值参数、分配含越权能力的角色，或尝试维护受保护的超级管理员角色与账号。

## 修复步骤

1. 由具备足够能力和参数的管理员操作；超级管理员角色和账号由超级管理员维护。目标用户的角色不可见时需先取得角色读取能力和全部范围，不禁用防提权约束。

## 正例

```text
自己有采购审批能力时，给普通角色授予该能力
```

## 反例

```text
自己没有采购审批能力，却给别人分配该能力或包含它的角色
```

## 修复后验证

用真实操作人验证允许与拒绝场景，检查目标角色最终能力、参数和范围。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/admin/src/domain/constraints.ts:38`
- `packages/admin/src/domain/constraints.ts:40`
- `packages/admin/src/domain/constraints.ts:55`
- `packages/admin/src/domain/constraints.ts:61`
- `packages/admin/src/domain/constraints.ts:67`
- `packages/admin/src/domain/constraints.ts:69`
- `packages/admin/src/domain/constraints.ts:85`
- `packages/admin/src/domain/constraints.ts:88`
- `packages/admin/src/domain/constraints.ts:124`

实现片段（位置随框架版本更新）：

```ts
    if (!role.capabilities?.some((entry: { capability: string }) => entry.capability === '*') || ctx.actor?.kind === 'system') return ok();
    if (!ctx.capabilities.has('*')) return violation('[CAGE-GRANT-001] 只有超级管理员可以维护超级管理员角色');
    if (meta.capability === 'Role.archive' || (meta.capability === 'Role.revokeCapability' && input.capability === '*'))
      return violation('[CAGE-GRANT-001] 不能停用超级管理员角色或移除全部能力标记');
    return ok();
```
