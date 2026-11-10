# CAGE-CONN-013：出站幂等键无效或请求冲突

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

幂等键不是非空字符串，或同租户、连接器、操作、幂等键已经对应另一份请求。

## 修复步骤

1. 使用同一业务操作的稳定声明键；重试保持键和请求内容不变。
2. 新业务操作使用新键，不能覆盖已有执行记录。远端收到的键还包含租户隔离前缀。

## 正例

```text
idempotencyKey: payload => payload.id // 同业务操作的稳定键
```

## 反例

```text
复用旧键发送不同金额，或每次重试生成随机键
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:219`
- `packages/connectors/src/runtime.ts:244`

实现片段（位置随框架版本更新）：

```ts
  const key = ob.idempotencyKey(row.payload as any);
  if (!key || typeof key !== 'string') throw new ConnectorError('[CAGE-CONN-013] 出站幂等键必须为非空字符串', null, false);
  const requestHash = createHash('sha256').update(canonical(body)).digest('hex');
  const identity = { tenant_id: row.tenant_id, connector: ob.op.connector.name, operation: ob.op.name, idempotency_key: key };
  const locate = (db: typeof k.app) => db.selectFrom('sys.connector_execution').selectAll()
```
