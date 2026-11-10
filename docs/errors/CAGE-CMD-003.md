# CAGE-CMD-003：新建命令没有目标状态

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

from 为 new 时使用 to: null，新记录没有可保留的当前状态。

## 修复步骤

1. 新建必须指向已声明状态；to: null 只用于已有记录的字段更新，仍检查 from、身份、版本并写审计。

## 正例

```text
from: 'new', to: 'draft' // 或已有记录 from: 'approved', to: null
```

## 反例

```text
from: 'new', to: null
```

## 修复后验证

重跑 cage check、gen 和相关命令测试，检查生成输入/方法签名。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/command.ts:233`

实现片段（位置随框架版本更新）：

```ts
  if (from === 'new' && def.to === null) {
    throw declError('CAGE-CMD-003', `${agg.name} 的新建命令必须指定目标状态，不能使用 to: null`);
  }
  if (def.to !== null && !hasStates(agg, def.to as string)) {
    throw declError('CAGE-STATE-001', `${agg.name} 的命令 to 是未声明的状态：${String(def.to)}`);
```
