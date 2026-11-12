# CAGE-GEN-002：声明结构没有对应迁移

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：gen --check / verify。

声明的期望结构与最后一个迁移内嵌的结构快照不一致。

## 修复步骤

1. 运行 pnpm gen 生成新迁移草稿，审查回填、非空与破坏性变更后提交；实际落库还需 pnpm migrate。

## 正例

```text
新增字段 → gen → 审查新迁移 → migrate
```

## 反例

```text
修改已执行 0001_init.sql，或把 gen 当作已更新数据库
```

## 修复后验证

重新生成并审查后执行 cage gen --check；结构变化还需审查并执行 migrate。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/gen/index.ts:209`

实现片段（位置随框架版本更新）：

```ts
      findings.push({
        code: 'CAGE-GEN-002',
        at: cfg.migrations,
        reason: `声明的表结构与迁移不一致（${stmts.length} 处变化）`,
        fix: '运行 cage gen 生成迁移草稿，人审后提交',
```

</details>
