# CAGE-ROUTE-001

## 什么时候出现

命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。

来源：[packages/lint/src/rules/no-manual-routes.ts:11](../../packages/lint/src/rules/no-manual-routes.ts)

```ts
    docs: { description: '禁止在业务项目里手写 HTTP 路由' },
    messages: { route: '[CAGE-ROUTE-001] 不要手写路由 {{call}}：在 domain 里声明命令或查询，路由由框架生成' },
    schema: [],
  },
  create(context) {
    return {
```

## 怎么修

在 domain 声明 command/query，让框架生成 HTTP 路由。

## 正例

```text
export const submit = command(Order, definition);
```

## 反例

```text
app.post('/api/order/submit', handler);
```
