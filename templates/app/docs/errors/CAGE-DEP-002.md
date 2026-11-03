# CAGE-DEP-002：适配器绕过命令写库

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：静态检查 / verify。

packages/adapters 依赖数据库访问包并可能直接写业务表。

## 修复步骤

1. 将适配器输出映射为领域命令输入，通过命令网关落实状态、审计和权限。

## 正例

```text
验签后调用 external 命令
```

## 反例

```text
适配器直接 update core.purchase_order
```

## 修复后验证

重跑 cage check 和 verify，确认边界修复而不是禁用规则。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/dependency-cruiser.cjs:17`

实现片段（位置随框架版本更新）：

```ts
      severity: 'error',
      comment: '[CAGE-DEP-002] 适配器必须通过命令网关写数据',
      from: { path: '^packages/adapters' },
      to: { path: 'node_modules/(pg|kysely)/' },
    },
```
