# CAGE-CONN-010：外部响应不符合 schema

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

外部返回成功 HTTP 状态，但内容不满足声明的 response schema。

## 修复步骤

1. 对照真实协议、响应样例和声明，修正一方；不要用 any 或空对象吞掉未知格式。该错误按永久失败处理。

## 正例

```text
response: z.object({ erpNo: z.string() }) 与真实成功协议一致
```

## 反例

```text
后端返回 { orderNo: 123 }，却继续读取 res.erpNo
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:186`

实现片段（位置随框架版本更新）：

```ts
      const result = o.response.safeParse(json);
      if (!result.success) throw new ConnectorError(`[CAGE-CONN-010] ${o.connector.name}.${o.name} 的响应格式与声明不符`, res.status, false, 'unknown');
      return result.data;
    });
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'ok', httpStatus, body, parsed);
```
