# CAGE-REG-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/registry.ts:133](../../packages/kernel/src/registry.ts)

```ts
    if (!aggSet.has(c.cmd.agg)) throw declError('CAGE-REG-001', `命令 ${c.capability} 所属的聚合 ${c.cmd.agg.name} 没有从 domain 导出`);
    if (caps.has(c.capability)) throw declError('CAGE-REG-003', `能力点重复：${c.capability}，可用 command({ name }) 区分`);
    caps.add(c.capability);
    for (const [alias, a] of Object.entries(c.cmd.reads)) {
      if (!aggSet.has(a)) throw declError('CAGE-REG-001', `命令 ${c.capability} 的 reads.${alias} 引用的聚合没有导出`);
    }
```

## 怎么修

检查统一入口中的聚合/命令引用及名称是否重复，所有依赖都必须在注册表中。

## 正例

```text
export * from './purchase-order.js';
```

## 反例

```text
// 命令引用了没有从入口导出的聚合
```
