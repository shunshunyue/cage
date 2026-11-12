# CAGE-INIT-003：三种连接身份或目标不一致

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：init。

APP/READ/MIGRATE 账号不是各自 Cage 账号，或三者及管理员连接不指向同一目标数据库。

## 修复步骤

1. 核对 URL 的用户名、主机、端口、数据库名；各自使用正确账号，并连接同一个库，不输出密码。

## 正例

```text
cage_app/cage_read/cage_migrate 均连接同一 host:port/business_db
```

## 反例

```text
app 连接 business_db，而 read/migrate 指向另一个库
```

## 修复后验证

恢复/核对配置后运行 cage init 验证，随后按流程 gen、审查迁移并 migrate；不输出凭证。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/init.ts:30`
- `packages/cli/src/init.ts:117`

实现片段（位置随框架版本更新）：

```ts
    if (url.username !== accounts[key] || url.host !== target.host || url.pathname !== target.pathname) {
      throw new Error('[CAGE-INIT-003] APP / READ / MIGRATE 需使用各自的 cage 账号，指向同一个数据库；请检查 .env');
    }
    const client = new pg.Client({ connectionString: urls[key], connectionTimeoutMillis: 5000 });
    try {
```

</details>
