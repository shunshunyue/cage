# CAGE-NAME-004：命令名必须小驼峰

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

command 显式 name 不是小驼峰。

## 修复步骤

1. name 使用小驼峰；中文按钮与图谱展示名另配，导出变量可用唯一业务前缀。

## 正例

```text
name: 'submit'
```

## 反例

```text
name: '提交审批'
```

## 修复后验证

重跑 cage check/gen；改动线上标识时还要审查能力、路由、迁移及旧消费者影响。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/command.ts:243`

实现片段（位置随框架版本更新）：

```ts
  if (def.name !== undefined && !/^[a-z][A-Za-z0-9]*$/.test(def.name)) {
    throw declError('CAGE-NAME-004', `命令名 ${def.name} 必须是小驼峰`);
  }
  return Object.freeze({
    [COMMAND]: true as const,
```
