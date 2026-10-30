# CAGE-DEP-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/lint/dependency-cruiser.cjs:24](../../packages/lint/dependency-cruiser.cjs)

```ts
      severity: 'error',
      comment: '[CAGE-DEP-003] 前端只能依赖 @app/contracts',
      from: { path: '^apps/web' },
      to: { path: '^packages/domain|node_modules/@yss123/cage-(kernel|http|admin|connectors|approval|testkit)/' },
    },
    {
```

## 怎么修

移除业务层的 IO 或越层依赖。读取放进 reads，外部调用放进 outbound，前端依赖 contracts。

## 正例

```text
reads: { stock: Inventory }
// handler 中
await deps.stock.get(id);
```

## 反例

```text
import pg from 'pg'; // domain 中禁止直接访问数据库
```
