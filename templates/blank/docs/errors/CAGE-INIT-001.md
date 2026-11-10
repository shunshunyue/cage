# CAGE-INIT-001：管理员 URL 没有数据库名

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：init。

init 的管理员连接没有指定一个明确的已有数据库。

## 修复步骤

1. 在 URL 路径填写实际数据库名，确认该库已经存在；init 不负责创建数据库。

## 正例

```text
postgresql://postgres:已编码密码@主机:端口/business_db
```

## 反例

```text
postgresql://postgres:密码@主机:端口/
```

## 修复后验证

恢复/核对配置后运行 cage init 验证，随后按流程 gen、审查迁移并 migrate；不输出凭证。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/init.ts:100`

实现片段（位置随框架版本更新）：

```ts
  if (!target.pathname || target.pathname === '/') {
    throw new Error('[CAGE-INIT-001] 管理员连接必须指定已经存在的数据库名，例如 postgresql://postgres:密码@localhost:5432/business_db');
  }
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000, application_name: 'cage-init' });
  let staged: string | undefined;
```
