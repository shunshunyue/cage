# CAGE-PAIR-002：离开持有资源状态却没有释放

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：图规则。

图规则沿进入状态的 acquires 反应推断资源持有，发现离开该状态的迁移没有 releases 路径，也未进入同样持有的状态。

## 修复步骤

1. 沿报错命令 → emits → reaction → 释放命令检查，新增所需事件与真正释放行为。
2. 释放反应标注与获取一致的资源名；检查取消、收货、撤回等每条离开路径及 map 的条件分支。
3. 标签只参与静态分析，不会自动释放资源；重要路径需用业务数据验证。不要删除 acquires 或添加永不执行的 map 来骗过检查。

## 正例

```text
reaction(OrderCancelled, { command: releaseLock, releases: 'inventory.lock', map: e => e.previousStatus === 'approved' ? { id: e.orderId } : null })
```

## 反例

```text
新增 approved → draft 的撤回命令，却没有事件及释放反应
```

## 修复后验证

重跑 cage check，并用业务用例验证每条关键离开路径确实释放资源。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:63`
- `packages/cli/src/rules.ts:67`
- `packages/cli/src/rules.ts:81`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-PAIR-002：进入某状态时获得了资源，从该状态出发的每一条迁移都必须释放它，或进入一个同样持有它的状态 */
/**
 * 检查离开持有状态的迁移是否声明释放，或进入同样持有资源的状态。
 * @param g 当前图。
```

</details>
