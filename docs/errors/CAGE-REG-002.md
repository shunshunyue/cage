# CAGE-REG-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/registry.ts:86](../../packages/kernel/src/registry.ts)

```ts
          if (aggregates.some((a) => a.name === (v as AnyAggregate).name)) {
            throw declError('CAGE-REG-002', `聚合名重复：${(v as AnyAggregate).name}`);
          }
          aggregates.push(v as AnyAggregate);
          break;
        case 'COMMAND': {
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
