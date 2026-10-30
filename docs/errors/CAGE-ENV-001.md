# CAGE-ENV-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/migrate.ts:51](../../packages/cli/src/migrate.ts)

```ts
  const urls = urlsFromEnv(env);
  if (!urls.migrate) throw new Error('[CAGE-ENV-001] 设置 CAGE_MIGRATE_DATABASE_URL');
  if (init) {
    if (!env.CAGE_SUPER_DATABASE_URL) throw new Error('[CAGE-ENV-001] 初始化需要 CAGE_SUPER_DATABASE_URL');
    const password = (url: string) => {
      const pw = decodeURIComponent(new URL(url).password);
```

## 怎么修

在运行环境设置 app/read/migrate 三种连接串，检查连接账号与库名。不要把凭证写进源码。

## 正例

```text
CAGE_APP_DATABASE_URL / CAGE_READ_DATABASE_URL / CAGE_MIGRATE_DATABASE_URL
```

## 反例

```text
// 未配置数据库连接就启动 API
```
