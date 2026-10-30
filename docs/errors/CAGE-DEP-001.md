# CAGE-DEP-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/static-check.ts:144](../../packages/cli/src/static-check.ts)

```ts
          findings.push({
            code: 'CAGE-DEP-001',
            at: loc(node),
            reason: `声明文件导入了 IO 模块 ${spec}`,
            fix: '需要外部数据就声明 reads；需要通知外部系统就发事件，由连接器的出站映射处理',
          });
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
