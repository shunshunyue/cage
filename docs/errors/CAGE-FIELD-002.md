# CAGE-FIELD-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/fields.ts:149](../../packages/kernel/src/primitives/fields.ts)

```ts
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-FIELD-002', 'ref() 的目标为空，可能是循环导入；可改为 ref("聚合名")');
  return mk(z.string().uuid(), { kind: 'ref', sql: 'uuid', ref: target });
}

type ShapeZod<S extends Fields> = {
```

## 怎么修

使用 field 工厂声明字段，避免覆盖 id/status/version 等系统列，引用指向存在的聚合。

## 正例

```text
fields: { deptId: ref('Dept'), amount: money() }
```

## 反例

```text
fields: { version: text() } // 系统版本号不能改作业务字段
```
