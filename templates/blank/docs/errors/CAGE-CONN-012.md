# CAGE-CONN-012：外部专用命令没有声明调用者

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明、图规则或 worker。

external 专用命令没有 inbound 或 outbound.onSuccess 等图内调用者；当前图规则给出 warning。

## 修复步骤

1. 补真实回调/成功映射并从入口导出，或明确这是暂未接线的功能。warning 不代表外部链路已完成。

## 正例

```text
recordErpNo 被 pushToErp.onSuccess.command 引用
```

## 反例

```text
定义 markReceived，却没有验签回调或其他外部调用入口
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:197`

实现片段（位置随框架版本更新）：

```ts
      findings.push({
        code: 'CAGE-CONN-012',
        at: at(c),
        reason: `命令 ${c.id} 只接受外部调用，但没有入站回调或出站映射调用它`,
        fix: '用 inbound(...) 或 outbound(..., { onSuccess }) 调用它',
```

</details>
