# CAGE-CONN-008：外部请求发生网络错误或超时

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

fetch 在收到有效 HTTP 响应前失败，例如 DNS、网络、TLS 或 timeout。

## 修复步骤

1. 核对脱敏后的主机、网络、代理和 timeoutMs；排除临时故障后由 worker 重试，不能在 handler 内加网络重试。

## 正例

```text
使用同步记录定位失败阶段；保持同一业务幂等键重试
```

## 反例

```text
每次重试换远端幂等键，导致重复写入
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:174`

实现片段（位置随框架版本更新）：

```ts
  } catch (e) {
    const err = e instanceof ConnectorError ? e : new ConnectorError(`[CAGE-CONN-008] 调用 ${o.connector.name}.${o.name} 失败：${(e as Error)?.name ?? 'Error'}`, httpStatus, o.effect !== 'write', 'unknown');
    await recordCall(opts.kernel, o, key, opts.tenantId ?? null, 'failed', httpStatus, body, undefined, err.message);
    throw err;
  }
```
