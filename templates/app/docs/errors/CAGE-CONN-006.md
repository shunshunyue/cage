# CAGE-CONN-006：回调命令未允许 external

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

入站回调指向的命令没有声明 external 调用身份。

## 修复步骤

1. 为专用回调命令声明 external；验签和输入校验之后才能调用，不把内部命令暴露为普通用户接口。

## 正例

```text
invokedBy: 'external'
```

## 反例

```text
invokedBy: 'user' // 作为 inbound.command
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:178`

实现片段（位置随框架版本更新）：

```ts
  if (!def.command.invokedBy.includes('external') && !def.command.invokedBy.includes('user')) {
    throw declError('CAGE-CONN-006', `入站回调调用的命令必须声明 invokedBy: 'external'`);
  }
  return Object.freeze({ [INBOUND]: true as const, connector: conn, event: eventName, ...def });
}
```
