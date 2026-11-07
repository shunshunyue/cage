# CAGE-REG-001：注册表缺少被引用声明

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载 / 执行。

命令、读依赖、反应、审批或任务引用了没有从 domain 入口导出的聚合/命令，或执行时找不到命令。

## 修复步骤

1. 从统一入口导出依赖双方，确认引用是同一个声明对象且名字正确；修复后重新 check/gen。

## 正例

```text
export * from './inventory.js'; export * from './purchase-order.js';
```

## 反例

```text
只导出反应，却没有导出它的目标命令
```

## 修复后验证

重跑 cage check/analyze/gen，确认统一入口包含引用双方。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/approval/src/route.ts:144`
- `packages/kernel/src/kernel.ts:118`
- `packages/kernel/src/registry.ts:171`
- `packages/kernel/src/registry.ts:177`
- `packages/kernel/src/registry.ts:182`
- `packages/kernel/src/registry.ts:196`
- `packages/kernel/src/registry.ts:200`
- `packages/kernel/src/registry.ts:230`

实现片段（位置随框架版本更新）：

```ts
        for (const query of s.context.queries ?? []) if (!registry.queries.some(q => q.name === query))
          throw declError('CAGE-REG-001', `AI 步骤引用的查询 ${query} 未导出`);
      }
    },
  });
```
