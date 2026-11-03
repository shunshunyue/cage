# CAGE-TEST-002：派生测试准备或初始夹具失败

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：test / verify。

派生测试在业务命令执行前无法构造合法夹具，或初始记录已经违反不变量。

## 修复步骤

1. 按 trace 的阶段、种子、fixture 和前置不变量修复准备数据；必要时提供业务 fixture。
2. 使用相同随机种子重放；区分准备失败与合法初始状态下的真实业务反例，不放宽不变量。

## 正例

```text
derived(domain, { seed: 20261103, /* 按公开类型提供合法 fixture */ })
```

## 反例

```text
初始预算已经不守恒，却报告命令破坏预算守恒
```

## 修复后验证

确认当前运行退出码与 JSON 报告，分别报告通过、失败和跳过。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/testkit/src/derived-diagnostics.ts:48`
- `packages/testkit/src/derived-diagnostics.ts:53`

实现片段（位置随框架版本更新）：

```ts
export class DerivedTestError extends Error {
  readonly code = 'CAGE-TEST-002';
  readonly phase: 'fixture' | 'execution';
  readonly aggregate: string;
  readonly seed: number;
```
