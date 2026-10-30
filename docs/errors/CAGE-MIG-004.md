# CAGE-MIG-004

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/migrate.ts:35](../../packages/cli/src/migrate.ts)

```ts
      throw new Error(
        '[CAGE-MIG-004] 集群已有 cage 账号，拒绝覆盖密码；请复用已初始化的库或使用独立 PostgreSQL 集群',
      );
    }
    await db.query('begin');
    await db.query(bootstrapSql(passwords, name));
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
