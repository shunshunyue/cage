# CAGE-CONN-001：连接器名称格式错误

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

connector 的名称不是小写字母开头的小写短横线格式。

## 修复步骤

1. 采用稳定的英文连接器标识，中文名称写 description 或图谱 label。

## 正例

```text
connector('finance-erp', definition)
```

## 反例

```text
connector('FinanceERP', definition)
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:63`

实现片段（位置随框架版本更新）：

```ts
export function connector<Ops extends Record<string, OpDef<any, any>>>(name: string, def: ConnectorDef<Ops>): Connector<Ops> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw declError('CAGE-CONN-001', `连接器名 ${name} 必须是小写短横线`);
  if (def.timeoutMs !== undefined && (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs <= 0 || def.timeoutMs > 300_000)) {
    throw declError('CAGE-CONN-015', '连接器 timeoutMs 必须是 1～300000 毫秒的整数');
  }
```
