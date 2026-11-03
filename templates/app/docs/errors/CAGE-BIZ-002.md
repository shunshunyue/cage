# CAGE-BIZ-002：业务流程与真实声明不一致

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载 / 图规则。

阶段不可达或无法结束，自动连线缺少真实触发链，人工/等待方式与目标入口不符，同对象状态不相接，或关联对象缺少实现依据。

## 修复步骤

1. 自动连线必须有 emits、事件触发、反应目标、审批结论或外部成功回写支持；reads、字段关联和状态相接不能证明自动调用。
2. 人工下一步使用用户可调用的命令，独立通知或调度使用 wait；核对前后命令的状态约束。
3. 关联的 via 引用本阶段实际可触发的声明，且该声明确实读取、写入或引用目标对象。补齐入口到所有阶段，以及各阶段到结束结果的路径。

## 正例

```text
{ from: 'draft', to: 'submit', mode: 'manual', label: '申请人提交' } // submit 允许 user 且状态相接
```

## 反例

```text
{ from: 'create', to: 'submit', mode: 'automatic', label: '自动提交' } // 只有状态相接，没有实际触发
```

## 修复后验证

重跑 cage check，再在 cage graph 中检查主线、分支、关联和实现代码；运行行为仍需相应业务回归。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/process-rules.ts:28`

实现片段（位置随框架版本更新）：

```ts
  const fail = (node: ViewNode, reason: string, fix: string) => findings.push({
    code: 'CAGE-BIZ-002', at: node.file ? `${node.file}:${node.line}` : node.id, reason, fix,
  });
  const actual = (start: string) => reachable(start, key => causalSuccessors(model, key));
  const involving = (start: string, target: string) => {
```
