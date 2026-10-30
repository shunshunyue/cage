# CAGE-READS-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/pipeline/load.ts:83](../../packages/kernel/src/pipeline/load.ts)

```ts
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then' && prop !== 'toJSON') {
        throw new Error(`[CAGE-READS-001] handler 使用了未声明的读依赖 ${prop}（详见 docs/errors/CAGE-READS-001.md）`);
      }
      return (target as any)[prop];
    },
  });
```

## 怎么修

在 reads 中声明所有读依赖，并确认目标聚合也从入口导出。

## 正例

```text
reads: { stock: Inventory }
```

## 反例

```text
reads: {} // handler 却读取 deps.stock
```
