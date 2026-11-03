# CAGE-IMPACT-002：命名本体快照无效

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：impact / 基线加载。

快照名非法、同名已存在、指定快照不存在，或快照格式损坏。

## 修复步骤

1. 先 cage snapshot list 核对已有名称，再用新的稳定名称保存。
2. 保存后通过 impact --snapshot 比较；不要覆盖旧基线或把修改后的图当成修改前状态。

## 正例

```text
cage snapshot save before-rental-change；cage impact --snapshot before-rental-change
```

## 反例

```text
多次使用同名快照覆盖唯一旧图
```

## 修复后验证

使用可靠基线重新 impact，确认报告中的变化与本次需求相符。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/impact.ts:60`
- `packages/cli/src/snapshots.ts:13`
- `packages/cli/src/snapshots.ts:25`
- `packages/cli/src/snapshots.ts:27`

实现片段（位置随框架版本更新）：

```ts
  const graph = value.graph ?? value;
  if (graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('[CAGE-IMPACT-002] 基线文件不是有效本体图或命名快照');
  return graph as Ontology;
}

```
