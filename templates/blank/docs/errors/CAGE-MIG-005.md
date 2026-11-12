# CAGE-MIG-005：已执行迁移内容被修改

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：migrate。

迁移文件校验和与 sys.schema_migrations 中记录不符。

## 修复步骤

1. 恢复执行时的原文件；结构更新新增迁移。换行引起差异时恢复原始字节并遵守仓库 LF 约定，不改数据库 checksum。

## 正例

```text
保留 0001_init.sql，新增 0002_add_field.sql
```

## 反例

```text
重写 0001，或手工修改迁移历史 checksum
```

## 修复后验证

在合适数据库上重新 migrate，确认迁移历史及 safe 读写权限，已执行文件保持原样。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/db/migrate.ts:81`

实现片段（位置随框架版本更新）：

```ts
      if (done.has(migration.name) && done.get(migration.name) !== checksum(migration.sql)) {
        throw new Error(`[CAGE-MIG-005] 已执行迁移 ${migration.name} 的内容被修改，请恢复原文件并新增迁移`);
      }
    }
    for (const m of all) {
```

</details>
