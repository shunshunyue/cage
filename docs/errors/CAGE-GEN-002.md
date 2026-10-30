# CAGE-GEN-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/gen/index.ts:122](../../packages/cli/src/gen/index.ts)

```ts
      findings.push({
        code: 'CAGE-GEN-002',
        at: cfg.migrations,
        reason: `声明的表结构与迁移不一致（${stmts.length} 处变化）`,
        fix: '运行 cage gen 生成迁移草稿，人审后提交',
      });
```

## 怎么修

运行 cage gen，检查生成契约与迁移草稿后提交；不要手改生成文件。

## 正例

```text
pnpm cage gen
pnpm cage gen --check
```

## 反例

```text
// 修改了 domain，但提交旧 contracts
```
