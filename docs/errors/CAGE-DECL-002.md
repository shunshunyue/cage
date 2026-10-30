# CAGE-DECL-002

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/static-check.ts:254](../../packages/cli/src/static-check.ts)

```ts
    .map((s) => ({
      code: 'CAGE-DECL-002',
      at: `${s.file}:${s.line}`,
      reason: `声明 ${s.exportName} 没有从 domain 入口导出，内核和抽取器都看不到它`,
      fix: `在 domain 的 index.ts 里加上 export * from './${s.file
        .split('/')
```

## 怎么修

将声明放在模块顶层，用唯一的 export const 名称声明，并从 domain/index.ts 导出。

## 正例

```text
export const Order = aggregate('Order', definition);
// index.ts
export * from './order.js';
```

## 反例

```text
function build() { return aggregate('Order', definition); }
```
