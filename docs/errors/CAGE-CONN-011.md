# CAGE-CONN-011：出站永久失败进入死信

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

出站消费者将不可重试的 ConnectorError 包装为永久错误；真正原因是内层错误码。

## 修复步骤

1. 先按内层 CAGE-CONN-007/009/010 等修正配置/协议，再重放死信；检查远端是否已完成写入并复用业务幂等键。

## 正例

```text
修复响应 schema，核对远端幂等结果，再重放指定 outboxId
```

## 反例

```text
只重启 worker，希望永久错误自动恢复或直接删 outbox
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:257`

实现片段（位置随框架版本更新）：

```ts
          // 不可重试：标成永久错误，直接进死信
          throw Object.assign(new Error(`[CAGE-CONN-011] ${e.message}`), { permanent: true });
        }
        throw e;
      }
```
