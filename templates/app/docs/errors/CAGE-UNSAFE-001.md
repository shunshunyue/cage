# CAGE-UNSAFE-001：逃生口缺少原因或负责人

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / lint / budget。

unsafe 的 reason/owner 缺失或为空，运行时或 lint 拒绝。

## 修复步骤

1. 先尝试正常声明；确需逃生口写清业务必要性、负责人和评审依据，并通过预算检查。它不会自动授予额外权限。

## 正例

```text
unsafe({ reason: '已评审的历史数据修复', owner: '数据负责人' }, action)
```

## 反例

```text
unsafe({ reason: '', owner: '' }, action)
```

## 修复后验证

运行相关 lint、budget 和真正业务用例，保留原因与负责人。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:241`
- `packages/lint/src/rules/unsafe-needs-reason.ts:8`

实现片段（位置随框架版本更新）：

```ts
export function unsafe<T>(tag: UnsafeTag, fn: () => T): T {
  if (!tag?.reason || !tag?.owner) throw declError('CAGE-UNSAFE-001', 'unsafe 必须写明 reason 和 owner');
  return fn();
}
(unsafe as any)[UNSAFE] = true;
```
