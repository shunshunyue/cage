# CAGE-STATE-004：状态名称重复

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

本页说明这一诊断的触发条件与修复方法。正反例为局部说明，完整业务输入以本项目声明为准。

## 何时出现

阶段：声明 / 图规则。

同一 states 集合内出现相同标识。

## 修复步骤

1. 保留唯一标识，需要不同含义的阶段使用不同状态名。

## 正例

```text
states('draft', 'approved')
```

## 反例

```text
states('draft', 'draft')
```

## 修复后验证

重跑 cage check、gen，审查状态图和相关状态迁移用例。

<details>
<summary>框架实现依据（维护者）</summary>

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/states.ts:56`

实现片段（位置随框架版本更新）：

```ts
  }
  if (new Set(values).size !== values.length) throw declError('CAGE-STATE-004', '状态名重复');
  const terminal = opts.terminal ?? [];
  for (const t of [...terminal, ...(opts.initial ? [opts.initial] : [])]) {
    if (!values.includes(t)) throw declError('CAGE-STATE-001', `状态 ${t} 未在 states 中声明`);
```

</details>
