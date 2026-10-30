# CAGE-CONN-011

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/connectors/src/runtime.ts:190](../../packages/connectors/src/runtime.ts)

```ts
          // 不可重试：标成永久错误，直接进死信
          throw Object.assign(new Error(`[CAGE-CONN-011] ${e.message}`), { permanent: true });
        }
        throw e;
      }
      if (ob.onSuccess) {
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
