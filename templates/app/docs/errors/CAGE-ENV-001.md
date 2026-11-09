# CAGE-ENV-001：缺少数据库连接配置

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：init / migrate / 启动。

API、worker、迁移或初始化没有取得所需的数据库连接。

## 修复步骤

1. 在应用根目录 .env 配置 CAGE_ADMIN_DATABASE_URL，指向已存在的数据库，运行 pnpm exec cage init 自动生成三种账号连接。
2. 已有账号则直接提供 APP/READ/MIGRATE URL；主机、端口、库名一致，账号各司其职。migrate 需要迁移连接。
3. 确认运行目录、部署环境覆盖值及服务已重启；不要输出凭证，也不要给日常服务改用管理员连接。

## 正例

```text
配置已有库 → cage init → gen → 审查后 migrate → dev
```

## 反例

```text
未配置连接就启动，或新增自动临时数据库兜底掩盖错误
```

## 修复后验证

重跑原先失败的命令，确认使用预期库与账号；输出脱敏信息。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/init.ts:94`
- `packages/cli/src/migrate.ts:39`
- `packages/kernel/src/db/connect.ts:91`
- `packages/kernel/src/kernel.ts:146`

实现片段（位置随框架版本更新）：

```ts
  if (!configured(adminUrl)) {
    if (!hasSaved) throw new Error('[CAGE-ENV-001] 首次初始化请在项目 .env 填写 CAGE_ADMIN_DATABASE_URL，连接已有数据库后运行 pnpm exec cage init');
    await verifyConnections(saved);
    return { status: 'reused', envFile };
  }
```
