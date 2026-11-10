# CAGE-MIG-001：迁移事务执行失败

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：migrate。

某个系统或业务迁移 SQL 执行出错；错误信息附迁移名和 PostgreSQL 原因。

## 修复步骤

1. 核对迁移账号、依赖顺序、旧数据与 SQL；失败事务已回滚，修复未执行草稿后重跑。已执行历史不得改写。

## 正例

```text
修复尚未执行草稿中的非空字段回填，再运行 pnpm migrate
```

## 反例

```text
用读账号迁移，或忽略失败继续启动业务
```

## 修复后验证

在合适数据库上重新 migrate，确认迁移历史及 safe 读写权限，已执行文件保持原样。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/db/migrate.ts:94`

实现片段（位置随框架版本更新）：

```ts
        await client.query('rollback');
        throw new Error(`[CAGE-MIG-001] 迁移 ${m.name} 失败：${(e as Error).message}`);
      }
      applied.push(m.name);
    }
```
