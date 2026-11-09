# CAGE-CMD-002：已有记录命令缺少 id

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

非新建命令的对象输入 schema 没有 id，无法确定要加载哪条记录。

## 修复步骤

1. 在 input 添加 UUID id；没有其他输入时可省略 input 使用默认 idOnly。

## 正例

```text
input: z.object({ id: z.string().uuid(), title: z.string() })
```

## 反例

```text
input: z.object({ title: z.string() }) // from 不是 new
```

## 修复后验证

重跑 cage check、gen 和相关命令测试，检查生成输入/方法签名。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/command.ts:240`

实现片段（位置随框架版本更新）：

```ts
  if (from !== 'new' && input instanceof z.ZodObject && !('id' in input.shape)) {
    throw declError('CAGE-CMD-002', `${agg.name} 的非新建命令输入必须包含 id`);
  }
  if (def.name !== undefined && !/^[a-z][A-Za-z0-9]*$/.test(def.name)) {
    throw declError('CAGE-NAME-004', `命令名 ${def.name} 必须是小驼峰`);
```
