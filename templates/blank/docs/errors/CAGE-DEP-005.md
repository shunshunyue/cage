# CAGE-DEP-005：domain 反向依赖生成物

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：静态检查 / verify。

domain 引用 generated 或 packages/contracts，形成生成循环。

## 修复步骤

1. 领域源码是生成源头；前端/适配层使用 contracts，domain 使用本地领域类型和公开声明 API。

## 正例

```text
domain 从 './purchase-order.js' 读领域符号
```

## 反例

```text
domain 从 '@app/contracts' 导入自己生成的快照
```

## 修复后验证

重跑 cage check 和 verify，确认边界修复而不是禁用规则。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/dependency-cruiser.cjs:36`

实现片段（位置随框架版本更新）：

```ts
      severity: 'error',
      comment: '[CAGE-DEP-005] domain 不能依赖生成物',
      from: { path: '^packages/domain' },
      to: { path: '^(generated|packages/contracts)/' },
    },
```
