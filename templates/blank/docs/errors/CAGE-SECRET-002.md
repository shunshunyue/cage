# CAGE-SECRET-002：源码疑似包含密钥字面量

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：lint / 外呼或回调。

lint 在配置或代码中发现疑似密钥值。

## 修复步骤

1. 删除源码密钥，改为密钥名/环境注入；真实凭证若已暴露要轮换，不仅删掉文案。

## 正例

```text
verify: hmacSha256('ERP_WEBHOOK_SECRET')
```

## 反例

```text
在源码里填真实 API token 或私钥
```

## 修复后验证

确认源码/日志不含值，重启后验证相应外呼或签名回调。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/src/rules/no-secret-literal.ts:34`

实现片段（位置随框架版本更新）：

```ts
    docs: { description: '禁止密钥字面量' },
    messages: { secret: '[CAGE-SECRET-002] 疑似{{what}}写在了代码里：密钥只写名字，值由密钥管理服务注入' },
    schema: [],
  },
  create(context) {
```
