# CAGE-BIZ-001：业务流程声明无效

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载 / 图规则。

流程或板块标识重复、名称说明缺失、入口/连线/结束阶段无效，或引用的真实声明未从 domain 导出。

## 修复步骤

1. 使用 businessProcess 声明阅读规格，填写流程、板块、阶段及连线说明；阶段引用已导出的真实业务声明。
2. 主对象使用聚合引用；相同板块 ID 的名称和说明保持一致。流程不调度命令，也不授予权限。

## 正例

```text
export const orderFlow = businessProcess('order-flow', { /* 完整阶段和转移，均引用真实声明 */ });
```

## 反例

```text
transitions: [{ from: 'draft', to: 'missing', mode: 'automatic', label: '继续' }] // missing 阶段不存在
```

## 修复后验证

重跑 cage check，再在 cage graph 中检查主线、分支、关联和实现代码；运行行为仍需相应业务回归。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/business-process.ts:58`
- `packages/kernel/src/registry.ts:206`
- `packages/kernel/src/registry.ts:209`
- `packages/kernel/src/registry.ts:212`

实现片段（位置随框架版本更新）：

```ts
): BusinessProcess {
  const invalid = (reason: string): never => { throw declError('CAGE-BIZ-001', `${name}：${reason}`); };
  const identifier = (value: string) => /^[a-z][a-z0-9-]*$/.test(value);
  const text = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (!identifier(name) || !identifier(def.area.id)) invalid('流程与板块标识须使用小写短横线格式');
```
