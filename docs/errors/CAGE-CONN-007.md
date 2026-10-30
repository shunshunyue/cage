# CAGE-CONN-007

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/connectors/src/runtime.ts:131](../../packages/connectors/src/runtime.ts)

```ts
  const host = o.connector.hosts[st];
  if (!host) throw new ConnectorError(`[CAGE-CONN-007] 连接器 ${o.connector.name} 没有 ${st} 环境的地址`, null, false);
  const token = o.connector.secret ? await secrets.get(o.connector.secret) : undefined;
  await take(o.connector);
  const url = new URL(o.path, `https://${host}`);
  if (o.method === 'GET') for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v));
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
