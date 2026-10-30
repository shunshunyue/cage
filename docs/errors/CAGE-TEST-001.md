# CAGE-TEST-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/verify.ts:36](../../packages/cli/src/verify.ts)

```ts
  if (code !== 0) return code;
  if (!existsSync(report)) throw new Error('[CAGE-TEST-001] 测试进程未输出结果报告，不能判定通过');
  const result = JSON.parse(readFileSync(report, 'utf8'));
  if (result.numPendingTests) console.log(`覆盖提示：${result.numPendingTests} 个用例跳过，请结合业务测试验收。`);
  return result.success ? 0 : 1;
}
```

## 怎么修

检查 Vitest 的输出及配置。必须生成当前运行的 JSON 报告，失败不能当作通过。

## 正例

```text
cage test
// .cage/test-results.json 中 success: true
```

## 反例

```text
// 测试启动失败却复用上一次结果
```
