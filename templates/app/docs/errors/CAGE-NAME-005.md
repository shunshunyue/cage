# CAGE-NAME-005：查询名必须小驼峰

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明加载。

query 名称格式不满足小驼峰。

## 修复步骤

1. 使用小驼峰查询名，保持生成契约与路由的稳定标识。

## 正例

```text
query('poByStatus', definition)
```

## 反例

```text
query('PO_BY_STATUS', definition)
```

## 修复后验证

重跑 cage check/gen；改动线上标识时还要审查能力、路由、迁移及旧消费者影响。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:165`

实现片段（位置随框架版本更新）：

```ts
): Query<I> {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw declError('CAGE-NAME-005', `查询名 ${name} 必须是小驼峰`);
  if (!def.sql === !def.build) throw declError('CAGE-QUERY-001', `查询 ${name} 必须二选一：sql 或 build`);
  if (def.sql && /\bcore\.|\bsys\./i.test(def.sql)) {
    throw declError('CAGE-QUERY-002', `查询 ${name} 引用了基表，只能引用 safe.* 安全视图`);
```

</details>
