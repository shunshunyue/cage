# CAGE-DECL-004：跨文件导出名冲突

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：静态检查 / 注册。

多个文件导出了同名声明，export * 汇总会产生歧义并丢失导出。

## 修复步骤

1. 给导出变量唯一名字；需要保留最终命令名时用 command 的 name 覆盖。

## 正例

```text
export const createNote = command(Note, { name: 'create', ... })
```

## 反例

```text
note.ts 与 order.ts 都 export const create，再 export *
```

## 修复后验证

重跑 cage check/analyze，确认声明出现在本体图，再运行 gen。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/static-check.ts:242`

实现片段（位置随框架版本更新）：

```ts
      findings.push({
        code: 'CAGE-DECL-004',
        at: `${list[0].file}:${list[0].line}`,
        reason: `导出名 ${n} 在 ${list.map((s) => s.file).join('、')} 里重复，export * 会把它们都丢掉`,
        fix: '改成不重复的导出名；命令可以用 command(X, { name: "原名" }) 保持能力点不变',
```
