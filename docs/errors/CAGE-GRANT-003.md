# CAGE-GRANT-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/admin/src/domain/constraints.ts:13](../../packages/admin/src/domain/constraints.ts)

```ts
  check: (_role, _ctx, input, meta) =>
    meta.catalog().includes(input.capability) ? ok() : violation(`[CAGE-GRANT-003] 能力点 ${input.capability} 不在能力目录里`),
});

/** 防提权：不能授出自己没有的能力点；数值参数（额度）不能超过自己的 */
export const noEscalation = (): Constraint => ({
```

## 怎么修

先声明能力点，再由具有该能力和范围的管理员分配，不能通过界面发明能力。

## 正例

```text
capability: 'PurchaseOrder.read'
```

## 反例

```text
capability: 'PurchaseOrder.nonexistent'
```
