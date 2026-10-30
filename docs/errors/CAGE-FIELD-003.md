# CAGE-FIELD-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/aggregate.ts:83](../../packages/kernel/src/primitives/aggregate.ts)

```ts
    }
    if (!isField(v)) throw declError('CAGE-FIELD-003', `${name}.${k} 不是字段原语`);
    if ((RESERVED_FIELDS as readonly string[]).includes(k)) {
      throw declError('CAGE-FIELD-004', `${name}.${k} 是保留字段名，由内核维护`);
    }
    if (!/^[a-z][A-Za-z0-9]*$/.test(k)) throw declError('CAGE-NAME-002', `字段名 ${name}.${k} 必须是小驼峰`);
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
