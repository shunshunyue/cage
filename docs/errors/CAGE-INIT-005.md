# CAGE-INIT-005：显式组织初始化或凭据交付失败

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：init。

bootstrap 配置不完整，凭据文件已存在、权限无法限制，或组织初始化事务失败。

## 修复步骤

1. 审查执行迁移后，提供新的凭据文件路径和实际可用连接；父目录需存在。
2. 先修复文件权限或数据库错误，再重新执行；不能把密码转而打印到服务日志。

## 正例

```text
cage bootstrap --credentials-file .cage/admin-credentials.json // 新受限文件
```

## 反例

```text
覆盖已有凭据文件，或初始化失败后继续输出“成功”
```

## 修复后验证

恢复/核对配置后运行 cage init 验证，随后按流程 gen、审查迁移并 migrate；不输出凭证。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/bootstrap.ts:12`
- `packages/cli/src/bootstrap.ts:21`
- `packages/cli/src/bootstrap.ts:26`
- `packages/cli/src/bootstrap.ts:42`

实现片段（位置随框架版本更新）：

```ts
  try { closeSync(openSync(file, 'wx', 0o600)); }
  catch { throw new Error('[CAGE-INIT-005] 无法创建新的受限凭据文件；请使用不存在的文件，并检查父目录及其权限'); }
  if (process.platform === 'win32') {
    try {
      // Shell/sandbox accounts may differ from USERNAME. Grant the actual process identity by SID.
```
