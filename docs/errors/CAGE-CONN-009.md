# CAGE-CONN-009：外部服务返回非成功状态

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明、图规则或 worker。

连接器取得 HTTP 响应，但状态码不是成功码。

## 修复步骤

1. 看同步记录的状态与脱敏响应；核对鉴权、字段及限流。可重试性还受 effect 和状态码控制，不是所有 4xx 都会重试。

## 正例

```text
修正 401 的运行环境密钥，确认后重放失败事件
```

## 反例

```text
把所有 4xx 改成成功，或无限重试无效请求
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:183`

实现片段（位置随框架版本更新）：

```ts
      try { json = text ? JSON.parse(text) : null; } catch { /* 无效响应由下方 schema 统一诊断，不记录原文。 */ }
      if (!res.ok) throw new ConnectorError(`[CAGE-CONN-009] ${o.connector.name}.${o.name} 返回 ${res.status}`, res.status,
        o.effect !== 'write' && (res.status >= 500 || res.status === 429), res.status >= 500 ? 'unknown' : 'rejected');
      const result = o.response.safeParse(json);
      if (!result.success) throw new ConnectorError(`[CAGE-CONN-010] ${o.connector.name}.${o.name} 的响应格式与声明不符`, res.status, false, 'unknown');
```

</details>
