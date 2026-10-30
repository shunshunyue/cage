# CAGE-SCOPE-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/scope/index.ts:66](../../packages/kernel/src/scope/index.ts)

```ts
    default:
      throw new Error('[CAGE-SCOPE-001] 未知的范围组合子');
  }
}

/** 多个授权取并集：用 OR 连接；外层始终加租户条件。 */
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
