# CAGE-REACT-002：同事务反应链嵌套过深

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 写流水线。

同事务执行深度超出内核上限，常见原因是命令与事件互相触发形成循环。

## 修复步骤

1. 沿事件/反应图定位循环，减少同事务级联；仅在业务允许最终一致时改成 outbox，并避免异步循环。

## 正例

```text
单向批准 → 建锁，释放不会再次触发批准
```

## 反例

```text
批准触发建锁，建锁又触发批准，或随意调高深度上限
```

## 修复后验证

重跑 cage check；同事务链验证共同提交/回滚，异步链检查 worker 和死信。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/kernel.ts:202`

实现片段（位置随框架版本更新）：

```ts
    const agg = cmd.agg;
    if (depth > this.maxDepth) throw new Error(`[CAGE-REACT-002] 同事务反应嵌套超过 ${this.maxDepth} 层`);

    // 第 1 关：认证
    if (!ctx.actor || (ctx.actor.kind === 'anonymous' && !cmd.public)) throw cageError('UNAUTHENTICATED');
```
