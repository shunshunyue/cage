# CAGE-INIT-005：显式组织初始化或凭据交付失败

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

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

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/bootstrap.ts:19`
- `packages/cli/src/bootstrap.ts:23`
- `packages/cli/src/bootstrap.ts:32`
- `packages/cli/src/bootstrap.ts:45`
- `packages/cli/src/bootstrap.ts:61`

实现片段（位置随框架版本更新）：

```ts
 * @param file 已解析的目标路径，父目录必须存在，目标不得已存在。
 * @throws 创建或 ACL 限制失败时抛出 CAGE-INIT-005；已创建空文件可能保留，不能视为交付成功。
 */
export function protectCredentialFile(file: string): void {
  try { closeSync(openSync(file, 'wx', 0o600)); }
```

</details>
