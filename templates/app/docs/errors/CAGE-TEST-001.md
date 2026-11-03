# CAGE-TEST-001：测试进程没有生成结果报告

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：test / verify。

测试未输出当前运行的 JSON 结果，CLI 无法认定测试通过。

## 修复步骤

1. 查看 Vitest 的启动/配置错误并重跑，确认当前 .cage/test-results.json；不复用旧报告，不将 skipped 当作 passed。

## 正例

```text
测试正常退出并生成当前结果，分别报告 passed/failed/skipped
```

## 反例

```text
测试没启动，却读取上次 success:true 当作本次成功
```

## 修复后验证

确认当前运行退出码与 JSON 报告，分别报告通过、失败和跳过。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/verify.ts:36`

实现片段（位置随框架版本更新）：

```ts
  if (code !== 0) return code;
  if (!existsSync(report)) throw new Error('[CAGE-TEST-001] 测试进程未输出结果报告，不能判定通过');
  const result = JSON.parse(readFileSync(report, 'utf8'));
  if (result.numPendingTests) console.log(`覆盖提示：${result.numPendingTests} 个用例跳过，请结合业务测试验收。`);
  return result.success ? 0 : 1;
```
