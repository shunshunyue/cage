# CAGE-MIG-002：安全层重建失败

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：migrate。

迁移后的 safe 视图、范围函数或授权重建事务失败。

## 修复步骤

1. 核对 init 是否完成、迁移角色权限、聚合引用与安全层 SQL。修复后重新 migrate；不改读侧去访问基表。

## 正例

```text
用正确迁移账号重建安全层，验证普通用户读路径
```

## 反例

```text
为绕过视图错误，把查询改成 core.* 或管理员连接
```

## 修复后验证

在合适数据库上重新 migrate，确认迁移历史及 safe 读写权限，已执行文件保持原样。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/db/migrate.ts:106`

实现片段（位置随框架版本更新）：

```ts
      await client.query('rollback');
      throw new Error(`[CAGE-MIG-002] 重建安全层失败：${(e as Error).message}`);
    }
    log('安全层已重建');
    return { applied, safeLayerRebuilt: true };
```
