# CAGE-GRANT-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/admin/src/domain/constraints.ts:21](../../packages/admin/src/domain/constraints.ts)

```ts
    const mine = ctx.capabilities.get(input.capability);
    if (!mine) return violation('[CAGE-GRANT-001] 不能授出自己没有的能力点');
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (typeof v === 'number' && typeof mine[k] === 'number' && v > (mine[k] as number)) {
        return violation(`[CAGE-GRANT-001] 参数 ${k}=${v} 超过了你自己的 ${mine[k]}`);
      }
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
