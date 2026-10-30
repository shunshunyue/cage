# CAGE-AUTH-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/http/src/oidc.ts:20](../../packages/http/src/oidc.ts)

```ts
    (disco ??= fetch(new URL('.well-known/openid-configuration', o.issuer.endsWith('/') ? o.issuer : `${o.issuer}/`)).then(async (r) => {
      if (!r.ok) throw new Error(`[CAGE-AUTH-001] OIDC 发现文档获取失败：${r.status}`);
      return (await r.json()) as Discovery;
    }));
  const secure = opts.cookieSecure ?? process.env.NODE_ENV === 'production';

```

## 怎么修

核对 OIDC 发现文档、issuer 和客户端配置，在部署环境配置所需变量。

## 正例

```text
OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_REDIRECT_URI
```

## 反例

```text
// issuer 不匹配或缺少客户端配置
```
