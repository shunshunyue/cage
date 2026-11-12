# CAGE-UPGRADE-001：升级版本或 codemod 有歧义

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：upgrade。

当前 CLI 不含目标版本迁移，或 command 同时存在旧 caller 与新 invokedBy。

## 修复步骤

1. 先安装目标版本 CLI；dry-run 审查迁移。新旧属性同时存在时人工确定语义并保留一种，不让工具猜测。

## 正例

```text
安装目标 CLI → upgrade --dry-run → 审查后 upgrade
```

## 反例

```text
command(A, { caller: 'user', invokedBy: 'process', ... })
```

## 修复后验证

审查 dry-run 后升级，再按新版本运行 gen/verify，报告尚未完成的数据库/外部联调。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/upgrade.ts:60`
- `packages/cli/src/upgrade.ts:79`

实现片段（位置随框架版本更新）：

```ts
    if (old && obj?.getProperty('invokedBy'))
      throw new Error('[CAGE-UPGRADE-001] command 同时包含 caller 与 invokedBy，请手工消除歧义');
    old?.rename('invokedBy');
  }
  return file.getFullText();
```

</details>
