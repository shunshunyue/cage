# CAGE-AUTH-001：OIDC 发现文档获取失败

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：HTTP 登录。

HTTP 无法取得 OIDC issuer 的发现文档，或远端返回非成功状态。

## 修复步骤

1. 检查部署环境 OIDC issuer、发现地址、网络与证书配置；不要关闭认证或把 issuer 校验删掉。

## 正例

```text
配置可访问的 OIDC_ISSUER、正确客户端和回调地址
```

## 反例

```text
将不可访问的 issuer 当作已成功登录并继续建立会话
```

## 修复后验证

重新走真实 OIDC 登录和回调，确认会话中的用户与授权；不要仅验证发现文档能打开。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/http/src/oidc.ts:25`

实现片段（位置随框架版本更新）：

```ts
    (disco ??= fetch(new URL('.well-known/openid-configuration', o.issuer.endsWith('/') ? o.issuer : `${o.issuer}/`)).then(async (r) => {
      if (!r.ok) throw new Error(`[CAGE-AUTH-001] OIDC 发现文档获取失败：${r.status}`);
      return (await r.json()) as Discovery;
    }));
  const secure = opts.cookieSecure ?? process.env.NODE_ENV === 'production';
```
