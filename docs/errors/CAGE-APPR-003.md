# CAGE-APPR-003：审批结论未允许流程调用

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

审批结论命令的 invokedBy 不包含 process。

## 修复步骤

1. 将结论命令声明为 process；前端通过待办接口审批，不要为了显示按钮把结论改成用户可直调。

## 正例

```text
invokedBy: 'process'
```

## 反例

```text
invokedBy: 'user' // 用作审批结论
```

## 修复后验证

先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/flow.ts:250`

实现片段（位置随框架版本更新）：

```ts
    if (!c.invokedBy.includes('process')) {
      throw declError('CAGE-APPR-003', `审批结论命令必须声明 invokedBy: 'process'`);
    }
  }
  return Object.freeze({
```
