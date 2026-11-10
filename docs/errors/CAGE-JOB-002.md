# CAGE-JOB-002：任务调用了未声明的命令

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / worker。

job.run 中 call 的命令不在该任务的 calls 列表里。

## 修复步骤

1. 在 calls 显式列出实际允许调用且已导出的命令，核对命令身份；不能借任务绕过命令网关。

## 正例

```text
calls: [cancel]，run 使用 call(cancel, { id })
```

## 反例

```text
calls: []，run 却调用 cancel
```

## 修复后验证

先 cage check，再在独立测试环境用目标任务数据验证读取、调用与审计；不要等待生产定时器试错。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/worker/scheduler.ts:43`

实现片段（位置随框架版本更新）：

```ts
    async call(cmd: AnyCommand, input: unknown) {
      if (!j.calls.includes(cmd)) throw cageError('FORBIDDEN', { message: `[CAGE-JOB-002] 任务 ${j.name} 调用了未声明的命令` });
      return (await k.execute(cmd, input, ctx)) as any;
    },
  };
```
