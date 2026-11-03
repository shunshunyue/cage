# CAGE-READS-001：handler 使用了未声明读依赖

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：handler 执行。

handler 访问 deps 中不存在的别名。

## 修复步骤

1. 在命令 reads 添加真实聚合与正确别名，核对入口导出。不要通过 any 或自建仓储绕过依赖声明。

## 正例

```text
reads: { stock: Inventory }；使用 deps.stock.findOne({ sku })
```

## 反例

```text
reads: {}；使用 deps.stock
```

## 修复后验证

检查本体图 reads 边并运行该命令的业务用例。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/pipeline/load.ts:86`

实现片段（位置随框架版本更新）：

```ts
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then' && prop !== 'toJSON') {
        throw new Error(`[CAGE-READS-001] handler 使用了未声明的读依赖 ${prop}（详见 docs/errors/CAGE-READS-001.md）`);
      }
      return (target as any)[prop];
    },
```
