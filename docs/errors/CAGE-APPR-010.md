# CAGE-APPR-010：流程专用命令没有调用者

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

命令只允许 process 调用，但图中没有审批结论、反应或任务调用它。

## 修复步骤

1. 补实际 approval/reaction/job 引用并从入口导出；如果本来是用户操作，按需求纠正 invokedBy。不要增加空引用骗过检查。

## 正例

```text
approve 被 poApproval.onApproved 引用，或 acquireLock 被 lockOnApprove 引用
```

## 反例

```text
定义 process 命令但没有任何流程或反应调用
```

## 修复后验证

先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:175`
- `packages/cli/src/rules.ts:189`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-APPR-010：invokedBy 为 process 的命令必须有审批绑定或反应调用它，否则没有人能调用 */
/**
 * 检查仅流程/外部可调用的命令是否有声明调用入口。
 * @param g 当前图。
```
