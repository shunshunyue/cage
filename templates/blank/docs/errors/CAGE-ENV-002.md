# CAGE-ENV-002：运行配置不满足安全边界

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：init / migrate / 启动。

生产启动缺少足够强的 Cookie 密钥，或服务配置中的认证并发、超时等参数无效。

## 修复步骤

1. 按诊断的配置项设置合法值；生产提供独立生成的随机 Cookie 密钥并重启服务。
2. 只报告配置项名称和错误码，不输出密钥或整个环境文件。

## 正例

```text
由受控环境变量提供随机 CAGE_COOKIE_SECRET，并设置有界认证并发及队列
```

## 反例

```text
生产继续使用固定开发 Cookie 密钥，或给并发上限填入无穷值
```

## 修复后验证

重跑原先失败的命令，确认使用预期库与账号；输出脱敏信息。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/http/src/auth.ts:58`
- `packages/http/src/server.ts:86`
- `packages/http/src/server.ts:90`

实现片段（位置随框架版本更新）：

```ts
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 0) {
      throw new Error('[CAGE-ENV-002] passwordConcurrency 必须为正整数，passwordQueueLimit 必须为非负整数');
    }
  }

```
