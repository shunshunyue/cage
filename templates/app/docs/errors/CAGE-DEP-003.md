# CAGE-DEP-003：前端依赖服务端实现

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：静态检查 / verify。

apps/web 导入 domain 或 kernel/http/admin/connectors/approval/testkit 等服务端包。

## 修复步骤

1. 前端使用 @app/contracts 与 @yss123/cage-client；共享快照类型通过生成契约取得。

## 正例

```text
import { purchaseOrder } from '@app/contracts'
```

## 反例

```text
import { approve } from '@app/domain'
```

## 修复后验证

重跑 cage check 和 verify，确认边界修复而不是禁用规则。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/dependency-cruiser.cjs:29`

实现片段（位置随框架版本更新）：

```ts
      severity: 'error',
      comment: '[CAGE-DEP-003] 前端只能依赖 @app/contracts',
      from: { path: '^apps/web' },
      to: { path: '^packages/domain|node_modules/@yss123/cage-(kernel|http|files|admin|connectors|approval|testkit|ai|ontology)/' },
    },
```
