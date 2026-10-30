# CAGE-MIG-005

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/db/migrate.ts:71](../../packages/kernel/src/db/migrate.ts)

```ts
      if (done.has(migration.name) && done.get(migration.name) !== checksum(migration.sql)) {
        throw new Error(`[CAGE-MIG-005] 已执行迁移 ${migration.name} 的内容被修改，请恢复原文件并新增迁移`);
      }
    }
    for (const m of all) {
      if (done.has(m.name)) continue;
```

## 怎么修

恢复已经执行的迁移文件，不要修改数据库中的校验和来绕过检查。需要变更结构时新增迁移；若仅受换行转换影响，恢复原始文件字节并使用仓库的 LF 约定。

## 正例

```text
保留 0001_init.sql，新增 0002_add_field.sql，再运行 cage migrate
```

## 反例

```text
修改已执行的 0001_init.sql，或手工重写迁移历史的 checksum
```
