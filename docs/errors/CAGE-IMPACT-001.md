# CAGE-IMPACT-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/baseline.ts:45](../../packages/cli/src/baseline.ts)

```ts
    );
    if (code !== 0) throw new Error('[CAGE-IMPACT-001] 基线抽取失败，请修复基线声明或使用保存的 --base-file');
    return readOntology(join(project, '.cage/ontology.json'));
  } finally {
    // 先断开本次建立的 junction，避免清理工作树时遍历共享依赖目录。
    for (const link of links) unlinkSync(link);
```

## 怎么修

指定存在的 Git 提交，或保存过的完整 ontology.json。基线错误不能当作无变化。

## 正例

```text
cage impact --base-file baseline.json
```

## 反例

```text
cage impact // 没有指定基线
```
