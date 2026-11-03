# CAGE-ROUTE-001：业务项目手写 HTTP 路由

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：lint / verify。

业务代码调用 app.get/post 等手动注册接口，绕过声明生成路径。

## 修复步骤

1. 将普通业务写接口声明为 command、读接口声明为 query；API 入口只装配框架。协议扩展另按框架边界评估。

## 正例

```text
领域 command → gen → 自动路由和前端契约
```

## 反例

```text
app.post('/api/order/submit', handler)
```

## 修复后验证

重新生成，检查 generated/routes.json 和前端契约，再验证自动接口。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/src/rules/no-manual-routes.ts:11`

实现片段（位置随框架版本更新）：

```ts
    docs: { description: '禁止在业务项目里手写 HTTP 路由' },
    messages: { route: '[CAGE-ROUTE-001] 不要手写路由 {{call}}：在 domain 里声明命令或查询，路由由框架生成' },
    schema: [],
  },
  create(context) {
```
