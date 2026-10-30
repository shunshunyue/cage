# CAGE-MIG-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/migrate.ts:15](../../packages/cli/src/migrate.ts)

```ts
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name))
    throw new Error('[CAGE-MIG-003] 数据库名只允许小写字母、数字和下划线，以字母开头');
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  try {
    if (!(await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount)
```

## 怎么修

核对迁移 SQL、账号权限和目标数据库。初始化只用于独立新集群，已发布迁移不可重写。

## 正例

```text
pnpm cage migrate
```

## 反例

```text
// 用 cage_read 执行建表或覆盖已有集群角色密码
```
