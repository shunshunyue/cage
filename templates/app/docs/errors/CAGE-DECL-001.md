# CAGE-DECL-001：声明不在可抽取的顶层常量

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：静态检查 / 注册。

原语调用藏在函数、条件、循环中，或没有赋给顶层常量。

## 修复步骤

1. 改为模块顶层 export const，让注册表和静态抽取器都能看到；动态部分放在受支持的 handler/map 等函数。

## 正例

```text
export const Order = aggregate('Order', definition)
```

## 反例

```text
export function build() { return aggregate('Order', definition); }
```

## 修复后验证

重跑 cage check/analyze，确认声明出现在本体图，再运行 gen。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/static-check.ts:232`
- `packages/cli/src/static-check.ts:239`

实现片段（位置随框架版本更新）：

```ts
            findings.push({
              code: 'CAGE-DECL-001',
              at: loc(node),
              reason: `原语 ${name}() 写在函数、条件或循环里，抽取器看不到它`,
              fix: '原语必须在模块顶层用 export const 声明',
```

</details>
