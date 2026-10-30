# CAGE-CREATE-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/create.ts:8](../../packages/cli/src/create.ts)

```ts
  const root = resolve(target);
  if (existsSync(root)) throw new Error('[CAGE-CREATE-001] 目标路径已存在，请选择新目录');
  const here = dirname(fileURLToPath(import.meta.url));
  const template = [resolve(here, '../templates/app'), resolve(here, '../../../templates/app')].find(
    existsSync,
  );
```

## 怎么修

选择尚不存在的目标目录，并确认 CLI 安装包包含 templates/app。

## 正例

```text
cage create new-app
```

## 反例

```text
cage create existing-project // 拒绝覆盖已有项目
```
