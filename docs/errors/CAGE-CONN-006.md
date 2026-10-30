# CAGE-CONN-006

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/connectors/src/primitives.ts:155](../../packages/connectors/src/primitives.ts)

```ts
  if (!def.command.invokedBy.includes('external') && !def.command.invokedBy.includes('user')) {
    throw declError('CAGE-CONN-006', `入站回调调用的命令必须声明 invokedBy: 'external'`);
  }
  return Object.freeze({ [INBOUND]: true as const, connector: conn, event: eventName, ...def });
}

```

## 怎么修

核对 host 白名单、操作名、字段 schema 和签名。永久失败应先修正配置再重放死信。

## 正例

```text
hosts: { test: 'erp-sandbox.example.com', prod: 'erp.example.com' }
```

## 反例

```text
// outbound 映射发送了 request schema 之外的字段
```
