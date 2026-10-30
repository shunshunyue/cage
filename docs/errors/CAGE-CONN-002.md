# CAGE-CONN-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/connectors/src/primitives.ts:29](../../packages/connectors/src/primitives.ts)

```ts
export function op<Req extends z.ZodObject<any>, Res extends z.ZodType>(def: OpDef<Req, Res>): OpDef<Req, Res> {
  if (!def.path.startsWith('/')) throw declError('CAGE-CONN-002', `操作路径 ${def.path} 必须以 / 开头`);
  return def;
}

export interface ConnectorDef<Ops extends Record<string, OpDef<any, any>>> {
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
