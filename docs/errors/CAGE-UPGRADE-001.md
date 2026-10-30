# CAGE-UPGRADE-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/upgrade.ts:45](../../packages/cli/src/upgrade.ts)

```ts
    if (old && obj?.getProperty('invokedBy'))
      throw new Error('[CAGE-UPGRADE-001] command 同时包含 caller 与 invokedBy，请手工消除歧义');
    old?.rename('invokedBy');
  }
  return file.getFullText();
}
```

## 怎么修

先安装目标版本 CLI，再运行对应 codemod；遇到同时存在新旧字段时手工消除歧义。

## 正例

```text
cage upgrade --dry-run
```

## 反例

```text
command(A, { caller: 'user', invokedBy: 'process' })
```
