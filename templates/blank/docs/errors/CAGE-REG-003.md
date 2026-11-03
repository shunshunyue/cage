# CAGE-REG-003：命令能力点重复

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载 / 执行。

同一聚合的多个命令解析成同一个 Aggregate.command 能力点。

## 修复步骤

1. 为不同操作指定不同 name，跨文件导出名也保持唯一；相同操作复用同一命令对象。

## 正例

```text
name: 'submit' 与 name: 'cancel'
```

## 反例

```text
同一聚合两个命令都 name: 'update'
```

## 修复后验证

重跑 cage check/analyze/gen，确认统一入口包含引用双方。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/registry.ts:165`

实现片段（位置随框架版本更新）：

```ts
      throw declError('CAGE-REL-001', `${c.cmd.agg.name}.related 是生成客户端的关联读取入口；请为业务命令使用其他 name`);
    if (caps.has(c.capability)) throw declError('CAGE-REG-003', `能力点重复：${c.capability}，可用 command({ name }) 区分`);
    caps.add(c.capability);
    for (const [alias, a] of Object.entries(c.cmd.reads)) {
      if (!aggSet.has(a)) throw declError('CAGE-REG-001', `命令 ${c.capability} 的 reads.${alias} 引用的聚合没有导出`);
```
