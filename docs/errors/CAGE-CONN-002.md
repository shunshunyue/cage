# CAGE-CONN-002：外部操作路径格式错误

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

op.path 没有以斜线开头。

## 修复步骤

1. host 在连接器白名单中配置，操作 path 只写从 / 开始的相对接口路径。

## 正例

```text
path: '/api/purchase-orders'
```

## 反例

```text
path: 'https://erp.example.com/api/orders'
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:29`

实现片段（位置随框架版本更新）：

```ts
export function op<Req extends z.ZodObject<any>, Res extends z.ZodType>(def: OpDef<Req, Res>): OpDef<Req, Res> {
  if (!def.path.startsWith('/')) throw declError('CAGE-CONN-002', `操作路径 ${def.path} 必须以 / 开头`);
  return def;
}

```
