# CAGE-CONN-015：连接器超时或限流参数无效

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

timeoutMs 不是 1 至 300000 的整数，或 rateLimit.perSecond 不是有限正数。

## 修复步骤

1. 按第三方服务的实际边界设置有界超时和每秒限额。
2. 首阶段额度在单进程内生效；多进程共享限额需要额外设计，不能按本地额度推断全局限流。

## 正例

```text
timeoutMs: 10000, rateLimit: { perSecond: 5 }
```

## 反例

```text
timeoutMs: Infinity 或 rateLimit: { perSecond: 0 }
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:65`
- `packages/connectors/src/primitives.ts:68`

实现片段（位置随框架版本更新）：

```ts
  if (def.timeoutMs !== undefined && (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs <= 0 || def.timeoutMs > 300_000)) {
    throw declError('CAGE-CONN-015', '连接器 timeoutMs 必须是 1～300000 毫秒的整数');
  }
  if (def.rateLimit && (!Number.isFinite(def.rateLimit.perSecond) || def.rateLimit.perSecond <= 0)) {
    throw declError('CAGE-CONN-015', '连接器 rateLimit.perSecond 必须为有限正数');
```
