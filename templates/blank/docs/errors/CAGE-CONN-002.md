# CAGE-CONN-002：外部操作路径格式错误

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

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

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:31`

实现片段（位置随框架版本更新）：

```ts
export function op<Req extends z.ZodObject<any>, Res extends z.ZodType>(def: OpDef<Req, Res>): OpDef<Req, Res> {
  if (!def.path.startsWith('/')) throw declError('CAGE-CONN-002', `操作路径 ${def.path} 必须以 / 开头`);
  return def;
}

```

</details>
