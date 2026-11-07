# CAGE-WORKER-001：缺少必要后台引擎

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：worker 启动 / 投递 / 停机。

声明存在审批等必要消费者，但启动 worker 时没有提供相应引擎。

## 修复步骤

1. 按 domain 声明装配真实审批引擎和连接器运行环境，检查 worker manifest。
2. 不要删除审批声明或把必需引擎缺失降级为警告。

## 正例

```text
使用标准 createWorker 入口装配声明要求的审批引擎
```

## 反例

```text
带审批绑定的注册表启动时跳过审批引擎
```

## 修复后验证

核对同版本注册指纹、消费者清单、心跳和时间线，再验证投递及停机恢复。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/worker/consumers.ts:60`

实现片段（位置随框架版本更新）：

```ts
    if (!engine) {
      throw new Error(`[CAGE-WORKER-001] 审批绑定 ${name} 缺少流程 ${a.process} 的审批引擎；补齐路由或装配引擎后再启动 worker`);
    }
    out.push({
      name: `approval:${name}:start`,
```
