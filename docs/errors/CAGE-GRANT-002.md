# CAGE-GRANT-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/admin/src/domain/constraints.ts:37](../../packages/admin/src/domain/constraints.ts)

```ts
    const want = COMBINATOR_WIDTH[input.combinator as Combinator] ?? 99;
    return want <= ownWidth(ctx, input.aggregate) ? ok() : violation('[CAGE-GRANT-002] 不能授出比自己更宽的数据范围');
  },
});

/** 分配角色也是授权：被分配角色里的每个能力点和范围，操作人自己都必须有 */
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
