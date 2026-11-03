# CAGE-NAME-006：任务名必须小驼峰

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

job 名称格式不满足小驼峰。

## 修复步骤

1. 任务使用稳定的小驼峰名，中文意图放 description。

## 正例

```text
job('expireStaleOrders', definition)
```

## 反例

```text
job('Expire-Stale-Orders', definition)
```

## 修复后验证

重跑 cage check/gen；改动线上标识时还要审查能力、路由、迁移及旧消费者影响。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:203`

实现片段（位置随框架版本更新）：

```ts
): Job {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-006', `任务名 ${name} 必须是小驼峰`);
  if (def.cron.trim().split(/\s+/).length < 5) throw declError('CAGE-JOB-001', `任务 ${name} 的 cron 表达式不合法`);
  return Object.freeze({
    [JOB]: true as const,
```
