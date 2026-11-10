# CAGE-ENV-003：服务启动不能隐式初始化组织

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：init / migrate / 启动。

createServer 显式传入 bootstrap: true。初始化不能混入日常服务启动并输出密码。

## 修复步骤

1. 移除启动参数中的 bootstrap: true；先审查执行迁移，再显式执行 cage bootstrap。
2. 使用 --credentials-file 指定新的受限凭据文件；组织已有用户时不重置凭据。

## 正例

```text
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
```

## 反例

```text
createServer({ domain, bootstrap: true })
```

## 修复后验证

重跑原先失败的命令，确认使用预期库与账号；输出脱敏信息。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/http/src/server.ts:113`

实现片段（位置随框架版本更新）：

```ts
  }
  if (opts.bootstrap) throw new Error('[CAGE-ENV-003] 服务启动不再隐式初始化组织；请在受控初始化入口显式调用 bootstrapOrg 并安全交付初始凭据');
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 2000;
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1) throw new Error('[CAGE-ENV-002] readinessTimeoutMs 必须为正整数');
  // 开发会话密钥也是随机值，重启会使旧 CSRF/OIDC cookie 失效；多实例必须显式共享配置。
```
