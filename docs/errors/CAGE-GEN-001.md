# CAGE-GEN-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/gen/index.ts:48](../../packages/cli/src/gen/index.ts)

```ts
  findings: Finding[],
  code = 'CAGE-GEN-001',
) {
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (cur === content) return;
  if (check) {
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
