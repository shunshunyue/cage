# CAGE-CONN-012

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/rules.ts:157](../../packages/cli/src/rules.ts)

```ts
      findings.push({
        code: 'CAGE-CONN-012',
        at: at(c),
        reason: `命令 ${c.id} 只接受外部调用，但没有入站回调或出站映射调用它`,
        fix: '用 inbound(...) 或 outbound(..., { onSuccess }) 调用它',
        severity: 'warning',
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
