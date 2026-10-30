# CAGE-LINT-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/verify.ts:95](../../packages/cli/src/verify.ts)

```ts
    f.messages.map((m): Finding => ({
      code: /\[(CAGE-[\w-]+)\]/.exec(m.message)?.[1] ?? 'CAGE-LINT-001',
      at: `${f.filePath}:${m.line}`,
      reason: m.message,
      severity: m.severity === 1 ? 'warning' : 'error',
    })),
```

## 怎么修

根据输出中的 ruleId 修复语法或规则问题，再重跑 verify。

## 正例

```text
pnpm cage verify
```

## 反例

```text
// 用禁用 lint 代替修复业务边界
```
