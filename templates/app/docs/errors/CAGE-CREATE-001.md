# CAGE-CREATE-001：项目创建参数或模板资源有误

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：create-cage-app / cage create。

目标目录已存在、模板参数不属于 blank/purchase、非交互环境缺少目录或模板，或 CLI 包缺少所选模板。

## 修复步骤

1. 选择未存在的目录；若是缺模板，核对 CLI 安装版本/分发包，框架维护者检查构建资源。不要覆盖现有项目。
2. 交互终端可直接运行脚手架选择；CI/管道中显式传入目录及 --template blank 或 --template purchase。

## 正例

```text
pnpm exec cage create ../new-business-app --template blank
```

## 反例

```text
cage create . 覆盖当前已有业务项目
```

## 修复后验证

向一个新目录创建，检查 AGENTS.md、业务源码、docs/development 和 docs/errors，然后按 README 安装/构建。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/create-prompt.ts:17`
- `packages/cli/src/create-prompt.ts:24`
- `packages/cli/src/create-prompt.ts:29`
- `packages/cli/src/create.ts:45`
- `packages/cli/src/create.ts:47`
- `packages/cli/src/create.ts:54`

实现片段（位置随框架版本更新）：

```ts
 * @returns 完整创建选择；用户取消返回 null，由入口转换为取消退出码。
 * @throws 非交互缺项或模板名无效时抛出 CAGE-CREATE-001。
 */
export async function chooseApp(
  target?: string,
```
