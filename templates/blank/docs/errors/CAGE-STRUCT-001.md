# CAGE-STRUCT-001：业务源码目录不符合模块约定

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：check / analyze / verify（structure: modular）。

启用 structure: modular 后，domain/web 的 src 根目录出现业务文件，或使用约定之外的顶层源码目录。

## 修复步骤

1. 前端使用 app / modules / shared，src 根目录只保留 main.tsx；领域使用 modules / workflows / integrations / shared，根目录只保留 index.ts。
2. 把页面、表单、hooks 和业务辅助代码放在同一业务模块，需要时再拆文件；不要创建空目录凑层级。测试就近放置，类型声明 .d.ts 不受入口约束。
3. 目录调整后修正导入并运行 cage check、gen、verify；完整规范见 docs/ai/project-structure.md。

## 正例

```text
apps/web/src/modules/expense/pages/expense-list-page.tsx
packages/domain/src/modules/expense/expense.ts
```

## 反例

```text
apps/web/src/expense-list.tsx
packages/domain/src/expense.ts
```

## 修复后验证

按 docs/ai/project-structure.md 整理归属和导入后重跑 cage check 与 verify；不关闭目录规则，也不改业务表或能力标识。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/project-structure.ts:74`

实现片段（位置随框架版本更新）：

```ts
        findings.push({
          code: 'CAGE-STRUCT-001',
          at,
          reason: `${kind} 源码没有放入约定模块：${from.path}`,
          fix: `src 根目录只保留${kind === 'domain' ? '领域 index.ts' : '浏览器 main.tsx'}；业务按归属放入 ${layers.join(' / ')}，见 docs/ai/project-structure.md`,
```
