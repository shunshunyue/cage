# CAGE-CONN-009

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/connectors/src/runtime.ts:163](../../packages/connectors/src/runtime.ts)

```ts
    const retryable = o.effect === 'retryableWrite' || o.effect === 'read' ? res.status >= 500 || res.status === 429 : false;
    throw new ConnectorError(`[CAGE-CONN-009] ${o.connector.name}.${o.name} 返回 ${res.status}`, res.status, retryable);
  }
  const parsed = o.response.safeParse(json);
  if (!parsed.success) {
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'failed', res.status, body, json, '响应格式不符合声明');
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
