# CAGE-WORKER-003：后台任务未在停机时限内结束

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：worker 启动 / 投递 / 停机。

停止接收新任务并取消外部 IO 后，在途任务仍超过退出时限。

## 修复步骤

1. 检查任务、网络超时和阻塞阶段；等待在途任务结束后再释放锁与连接。
2. 核对恢复记录和远端幂等结果；不要在任务还执行时强行释放互斥锁。

## 正例

```text
先停止领取，再等待并核对运行任务的退出结果
```

## 反例

```text
停机时直接关锁连接，允许第二个实例和旧任务同时执行
```

## 修复后验证

核对同版本注册指纹、消费者清单、心跳和时间线，再验证投递及停机恢复。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/worker/index.ts:269`

实现片段（位置随框架版本更新）：

```ts
        const timeout = setTimeout(() => {
          state.lastError = `[CAGE-WORKER-003] 停机等待超时，在途任务：${snapshot().inFlight.join(', ')}`;
          log.error({ err: state.lastError }, 'worker 停机超时；任务结束前保留锁和连接');
          reject(new Error(state.lastError));
        }, opts.shutdownTimeoutMs ?? 30_000);
```
