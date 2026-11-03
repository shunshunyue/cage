# CAGE-GEN-001：契约等生成结果过期

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：gen --check / verify。

gen --check/verify 比较发现需提交的生成文件缺失或与声明不一致。

## 修复步骤

1. 改源声明后运行 pnpm gen，审查并提交结果；手改生成物会被覆盖，不靠更新预期掩盖错误。

## 正例

```text
修改 domain → pnpm gen → pnpm exec cage gen --check
```

## 反例

```text
直接编辑 packages/contracts/src/aggregates/purchase-order/index.ts
```

## 修复后验证

重新生成并审查后执行 cage gen --check；结构变化还需审查并执行 migrate。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/gen/index.ts:49`
- `packages/cli/src/gen/index.ts:91`

实现片段（位置随框架版本更新）：

```ts
  findings: Finding[],
  code = 'CAGE-GEN-001',
) {
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (cur === content) return;
```
