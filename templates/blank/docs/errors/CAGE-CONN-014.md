# CAGE-CONN-014：不可重试外部写入结果未知

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明、图规则或 worker。

不可安全重试的外部写入超时或中断，无法确认远端是否已经生效。

## 修复步骤

1. 先凭远端幂等键和同步记录人工核对结果，再选择连接器专用的受控恢复或业务补偿。当前没有通用回执确认或解除 unknown 的入口，普通死信重放不会解除。
2. 需要自动恢复时先让远端提供可靠幂等协议，再使用 retryableWrite；不盲目重放未知结果写入。

## 正例

```text
核对远端已生成凭证，再通过受控命令落实本地结果
```

## 反例

```text
超时等于远端没执行，直接再次扣款
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:245`

实现片段（位置随框架版本更新）：

```ts
  if (claim.kind === 'conflict') throw new ConnectorError(`[CAGE-CONN-013] ${consumer} 同一幂等键对应不同请求；禁止覆盖已有执行`, null, false);
  if (claim.kind === 'unknown') throw new ConnectorError(`[CAGE-CONN-014] ${consumer} 的不可重试调用结果未知；人工核对远端后再恢复`, null, false, 'unknown');
  if (claim.kind === 'busy') throw new ConnectorError(`${consumer} 的调用仍由其他执行者持有`, null, true);
  if (claim.kind === 'receipt') return { skipped: false, response: ob.op.response.parse(claim.response) };
  let response: unknown;
```

</details>
