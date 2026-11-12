# CAGE-CONN-005：入站事件名称格式错误

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明、图规则或 worker。

inbound 的事件名不是小驼峰格式。

## 修复步骤

1. 使用小驼峰稳定标识，展示文案另设中文。

## 正例

```text
inbound(erp, 'goodsReceived', definition)
```

## 反例

```text
inbound(erp, 'GoodsReceived', definition)
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:176`

实现片段（位置随框架版本更新）：

```ts
): Inbound<P> {
  if (!/^[a-z][A-Za-z0-9]*$/.test(eventName)) throw declError('CAGE-CONN-005', `入站事件名 ${eventName} 必须是小驼峰`);
  if (!def.command.invokedBy.includes('external') && !def.command.invokedBy.includes('user')) {
    throw declError('CAGE-CONN-006', `入站回调调用的命令必须声明 invokedBy: 'external'`);
  }
```

</details>
