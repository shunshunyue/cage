# CAGE-DECL-003

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/static-check.ts:207](../../packages/cli/src/static-check.ts)

```ts
                findings.push({
                  code: 'CAGE-DECL-003',
                  at: loc(node),
                  reason: `声明 ${topDecl.name.getText()} 没有用 export const 导出`,
                  fix: '加上 export const，并确认它从 domain 的 index.ts 导出',
                });
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
