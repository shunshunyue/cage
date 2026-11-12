# CAGE-IMPACT-002：命名本体快照无效

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

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

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/impact.ts:97`
- `packages/cli/src/snapshots.ts:24`
- `packages/cli/src/snapshots.ts:27`
- `packages/cli/src/snapshots.ts:56`
- `packages/cli/src/snapshots.ts:58`

实现片段（位置随框架版本更新）：

```ts
  const graph = value.graph ?? value;
  if (graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('[CAGE-IMPACT-002] 基线文件不是有效本体图或命名快照');
  return graph as Ontology;
}

```

</details>
