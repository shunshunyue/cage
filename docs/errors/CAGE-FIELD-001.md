# CAGE-FIELD-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/primitives/fields.ts:92](../../packages/kernel/src/primitives/fields.ts)

```ts
  sensitive(kind: SensitiveKind): Field<T, Opt> {
    if (!SENSITIVE_KINDS.includes(kind)) throw declError('CAGE-FIELD-001', `未知的敏感种类 ${kind}`);
    return this.with({ sensitiveKind: kind });
  }
  /** 唯一约束（租户内） */
  unique(): Field<T, Opt> {
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
