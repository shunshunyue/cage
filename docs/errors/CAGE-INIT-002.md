# CAGE-INIT-002：集群已有账号但缺少原凭证

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：init。

PostgreSQL 集群已经存在 Cage 登录角色，而本项目没有保存可复用的三种连接。

## 修复步骤

1. 从已有项目或管理员安全取得对应角色的原连接，填入本项目 .env，再运行 init 验证。
2. 角色名在集群共享；不要为新项目随机重置 cage_app/read/migrate 的密码，影响其他项目。
3. 如需完全隔离的账号策略，先规划集群/角色隔离方案；不删除共享角色绕过检查。

## 正例

```text
复用原 APP/READ/MIGRATE 凭证，指向本项目实际同一库
```

## 反例

```text
ALTER ROLE 重置共享账号密码，导致已有应用断连
```

## 修复后验证

恢复/核对配置后运行 cage init 验证，随后按流程 gen、审查迁移并 migrate；不输出凭证。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/init.ts:94`

实现片段（位置随框架版本更新）：

```ts
      if (existing.rowCount !== 4 || !hasSaved) {
        throw new Error('[CAGE-INIT-002] PostgreSQL 集群已有 Cage 账号；请在 .env 提供已有的 APP / READ / MIGRATE 连接后重试。初始化不会重置这些账号的密码');
      }
      if (new URL(saved.APP).host !== target.host || new URL(saved.APP).pathname !== target.pathname) {
        throw new Error('[CAGE-INIT-003] 已有账号连接与管理员连接必须指向同一个数据库；请检查 .env');
```
