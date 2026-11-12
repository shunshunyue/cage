# CAGE-ROUTE-001：业务项目手写 HTTP 路由

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

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

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/lint/src/rules/no-manual-routes.ts:3`
- `packages/lint/src/rules/no-manual-routes.ts:23`

实现片段（位置随框架版本更新）：

```ts
 * 检查业务代码是否绕过声明直接注册 HTTP 路由。
 * 通过常见接收器名、HTTP 方法和路径形状识别调用，命中返回 CAGE-ROUTE-001。
 * 这是有界语法检查，不解析任意变量别名或运行时动态路由；框架自己的 HTTP 实现由其维护边界管理。
 */
// 业务项目里禁止手写 HTTP 路由：没有声明就没有路由，所有写入都经过内核
```

</details>
