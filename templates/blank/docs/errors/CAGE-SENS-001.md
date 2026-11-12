# CAGE-SENS-001：敏感字段未标注就进入事件

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：图规则。

命令事件载荷包含与聚合同名的敏感字段，却没有对应 sensitive 标记。

## 修复步骤

1. 移除非必要敏感数据，或在事件保持一致 sensitive 标记以便掩码；自定义映射也要审查，字段改名不会自动证明安全。

## 正例

```text
event('OrderChanged', { phone: text().sensitive('phone') })
```

## 反例

```text
聚合 phone 为 sensitive，事件 phone 却是普通 text()
```

## 修复后验证

重跑 cage check，检查实际 outbox 载荷及普通读结果没有泄漏明文。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:144`
- `packages/cli/src/rules.ts:163`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-SENS-001：敏感字段不得原样进入事件载荷 */
/**
 * 检查事件同名载荷字段是否保留聚合敏感标记。
 * @param g 当前图。
```

</details>
