# CAGE-SYNC-001：AGENTS 托管区过期或标记损坏

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：sync / verify。

sync --check 发现框架规则需更新，或 begin/end 标记缺失一边、重复、顺序错误。

## 修复步骤

1. 保留唯一且有序的 begin/end，项目业务约定移到标记外，再运行 pnpm exec cage sync。同步只替换托管区，不升级业务和文档。

## 正例

```text
一个完整托管区，前后保留自己的业务规则
```

## 反例

```text
复制两段 begin/end，或只删除 end 标记
```

## 修复后验证

运行 cage sync 后再 sync --check，确认标记外业务约定保持不变。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/sync.ts:119`
- `packages/cli/src/sync.ts:132`

实现片段（位置随框架版本更新）：

```ts
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index! < starts[0].index!) {
    throw new Error('[CAGE-SYNC-001] 托管区标记不完整或重复，请修复 AGENTS.md 的 begin/end 标记');
  }
  return current.slice(0, starts[0].index) + latest + current.slice(ends[0].index! + ends[0][0].length);
}
```
