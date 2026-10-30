# CAGE-MIG-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/kernel/src/db/migrate.ts:96](../../packages/kernel/src/db/migrate.ts)

```ts
      await client.query('rollback');
      throw new Error(`[CAGE-MIG-002] 重建安全层失败：${(e as Error).message}`);
    }
    log('安全层已重建');
    return { applied, safeLayerRebuilt: true };
  } finally {
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
