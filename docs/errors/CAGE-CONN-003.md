# CAGE-CONN-003：地址白名单包含协议或路径

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

connector.hosts 中包含协议、路径或空白，而不是主机名（可带端口）。

## 修复步骤

1. 将协议和路径从 host 移除；实际路径写 op.path，环境 host 按声明配置。

## 正例

```text
hosts: { test: 'erp-sandbox.example.com:8443', prod: 'erp.example.com' }
```

## 反例

```text
hosts: { prod: 'https://erp.example.com/api' }
```

## 修复后验证

先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/primitives.ts:71`

实现片段（位置随框架版本更新）：

```ts
  for (const h of Object.values(def.hosts)) {
    if (h && /[/:\s]/.test(h.replace(/:\d+$/, ''))) throw declError('CAGE-CONN-003', `地址白名单只能写主机名（可带端口）：${h}`);
  }
  const c: any = {
    [CONNECTOR]: true,
```
