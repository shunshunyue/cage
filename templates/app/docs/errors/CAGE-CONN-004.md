# CAGE-CONN-004：只读操作被用作出站写映射

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

outbound 绑定了 effect 为 read 的操作。

## 修复步骤

1. 按真实副作用给操作声明 write/retryableWrite；有可重试写入时设计远端幂等协议，不能只改标签。

## 正例

```text
effect: 'retryableWrite' // 第三方实际支持幂等写入
```

## 反例

```text
effect: 'read' // 却在业务事件后创建远端订单
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:116`

实现片段（位置随框架版本更新）：

```ts
): Outbound<E, O> {
  if (operation.effect === 'read') throw declError('CAGE-CONN-004', '只读操作不能用于出站映射');
  const o: any = {
    [OUTBOUND]: true,
    event: ev,
```
