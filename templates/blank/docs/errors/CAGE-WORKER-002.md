# CAGE-WORKER-002：事件与消费者清单不匹配

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：worker 启动 / 投递 / 停机。

worker 收到未知事件或缺少声明要求的消费者，消息不能静默完成。

## 修复步骤

1. 通过 doctor/timeline 核对 API 与 worker 的版本、注册指纹、消费者清单和心跳。
2. 首阶段停止旧进程后同版本升级 API 与 worker，再检查死信并按允许方式恢复；不要直接修改 done 状态。

## 正例

```text
更新匹配版本后重放死信，确认消费者处理证据
```

## 反例

```text
旧 worker 对新关键事件找不到消费者仍标记 done
```

## 修复后验证

核对同版本注册指纹、消费者清单、心跳和时间线，再验证投递及停机恢复。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:263`
- `packages/kernel/src/worker/outbox.ts:39`
- `packages/kernel/src/worker/outbox.ts:94`

实现片段（位置随框架版本更新）：

```ts
    async handle(row, tx, _kernel, prepared) {
      if (!prepared) throw new Error('[CAGE-WORKER-002] 出站消费者必须经 worker prepare 阶段执行');
      const result = prepared as OutboundPrepared;
      if (result.skipped) return;
      if (ob.onSuccess) {
```
