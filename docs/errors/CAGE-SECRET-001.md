# CAGE-SECRET-001：运行环境缺少密钥

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：lint / 外呼或回调。

连接器或回调验签使用的密钥名在环境/密钥提供器中没有值。

## 修复步骤

1. 按声明的 secret/验签密钥名在 .env 或部署密钥系统注入，重启对应进程；不把值写进 domain 或日志。

## 正例

```text
secret: 'ERP_API_TOKEN'，运行环境提供该变量
```

## 反例

```text
把实际 token 填进 secret 字段，或打印所有环境变量找值
```

## 修复后验证

确认源码/日志不含值，重启后验证相应外呼或签名回调。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/connectors/src/runtime.ts:25`
- `packages/http/src/routes.ts:88`

实现片段（位置随框架版本更新）：

```ts
    const v = process.env[name];
    if (!v) throw new Error(`[CAGE-SECRET-001] 缺少密钥 ${name}（由密钥管理服务或环境变量注入）`);
    return v;
  },
};
```
