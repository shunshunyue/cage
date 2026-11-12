# CAGE-DEP-001：领域声明直接依赖 IO

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：静态检查 / verify。

domain 引入数据库、文件、网络或 HTTP 运行时等越界依赖。

## 修复步骤

1. 读取通过 reads，第三方交给连接器，框架装配放 apps/api；不要把 IO 移进 helper 后继续从 domain 间接调用。

## 正例

```text
reads: { stock: Inventory }；handler 使用 deps.stock.findOne(...)
```

## 反例

```text
import pg from 'pg'; // domain 直接操作数据库
```

## 修复后验证

重跑 cage check 和 verify，确认边界修复而不是禁用规则。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/static-check.ts:188`
- `packages/lint/dependency-cruiser.cjs:13`

实现片段（位置随框架版本更新）：

```ts
          findings.push({
            code: 'CAGE-DEP-001',
            at: loc(node),
            reason: `声明文件导入了 IO 模块 ${spec}`,
            fix: '需要外部数据就声明 reads；需要通知外部系统就发事件，由连接器的出站映射处理',
```

</details>
