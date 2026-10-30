# CAGE-DECL-004

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/cli/src/static-check.ts:239](../../packages/cli/src/static-check.ts)

```ts
      findings.push({
        code: 'CAGE-DECL-004',
        at: `${list[0].file}:${list[0].line}`,
        reason: `导出名 ${n} 在 ${list.map((s) => s.file).join('、')} 里重复，export * 会把它们都丢掉`,
        fix: '改成不重复的导出名；命令可以用 command(X, { name: "原名" }) 保持能力点不变',
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
