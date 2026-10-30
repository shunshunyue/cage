# CAGE-SCOPE-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/aggregate.ts:96](../../packages/kernel/src/primitives/aggregate.ts)

```ts
  for (const f of [sc.deptField, ownerField]) {
    if (f && f !== 'id' && !(f in fields)) throw declError('CAGE-SCOPE-002', `${name} 的范围字段 ${f} 不存在`);
  }
  const scope: ScopeSpec = Object.freeze({ ...sc, ownerField });

  return Object.freeze({
```

## 怎么修

选择内置范围组合子，引用聚合中真实存在的部门/创建人字段。

## 正例

```text
scope: scope.deptSubtree('deptId')
```

## 反例

```text
scope: scope.deptSubtree('missingField')
```
