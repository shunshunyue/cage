# CAGE-IMPACT-001：影响分析没有可用基线

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：impact / 基线加载。

impact 未指定基线，或 Git 基线无法加载/抽取。

## 修复步骤

1. 使用真实存在且能加载的提交，或修改前保存的完整 ontology.json。基线失败不能当作没有变化。

## 正例

```text
pnpm exec cage impact --base-file .cage/before-change.json
```

## 反例

```text
修改后才保存旧图，或指定不存在的提交并忽略失败
```

## 修复后验证

使用可靠基线重新 impact，确认报告中的变化与本次需求相符。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/baseline.ts:58`
- `packages/cli/src/main.ts:287`

实现片段（位置随框架版本更新）：

```ts
    );
    if (code !== 0) throw new Error('[CAGE-IMPACT-001] 基线抽取失败，请修复基线声明或使用保存的 --base-file');
    return readOntology(join(project, '.cage/ontology.json'));
  } finally {
    // 先断开本次建立的 junction，避免清理工作树时遍历共享依赖目录。
```
