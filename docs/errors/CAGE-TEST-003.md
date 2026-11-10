# CAGE-TEST-003：测试数据库目录归属不匹配

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：test / verify。

临时 PostgreSQL 的目录、归属标记、实际 data_directory 或端口与本次启动实例不符。

## 修复步骤

1. 保留诊断并核对本次测试自己的实例；修复路径或生命周期后重新运行。
2. 已有目录明确使用 persistent: true；不删除未知目录、不按进程名批量终止 PostgreSQL。

## 正例

```text
测试工具停止自己创建且验证归属的临时实例
```

## 反例

```text
将已有业务目录作为自动清理目录，或为了退出测试结束所有 postgres 进程
```

## 修复后验证

确认当前运行退出码与 JSON 报告，分别报告通过、失败和跳过。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/testkit/src/pg.ts:63`
- `packages/testkit/src/pg.ts:65`
- `packages/testkit/src/pg.ts:90`
- `packages/testkit/src/pg.ts:96`
- `packages/testkit/src/pg.ts:107`

实现片段（位置随框架版本更新）：

```ts
  const dir = resolve(opts.dir ?? mkdtempSync(join(tmpdir(), 'cage-pg-')));
  if (dir === parse(dir).root) throw new Error('[CAGE-TEST-003] 内嵌 PostgreSQL 目录不能是文件系统根目录');
  const fresh = !existsSync(join(dir, 'PG_VERSION'));
  if (!persistent && !fresh) throw new Error('[CAGE-TEST-003] 不允许将已有 PostgreSQL 目录作为自动删除的临时实例；使用 persistent: true');
  if (persistent) mkdirSync(dir, { recursive: true });
```
