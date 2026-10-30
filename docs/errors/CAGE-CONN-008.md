# CAGE-CONN-008

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/connectors/src/runtime.ts:151](../../packages/connectors/src/runtime.ts)

```ts
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'failed', null, body, undefined, String(e));
    throw new ConnectorError(`[CAGE-CONN-008] 调用 ${o.connector.name}.${o.name} 失败：${String(e)}`, null, true);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
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
