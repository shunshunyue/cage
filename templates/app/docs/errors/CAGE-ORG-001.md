# CAGE-ORG-001：业务入口遗漏组织模型

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：图规则 / 测试环境。

应用 domain 没有完整导出 User、Dept、Role。

## 修复步骤

1. 在统一入口保留框架组织模型导出；新业务引用组织模型，不复制第二套用户/角色实现。

## 正例

```text
export * from '@yss123/cage-admin/domain';
```

## 反例

```text
替换采购业务时把组织模型导出也删除
```

## 修复后验证

重跑 cage check/analyze，确认 User、Dept、Role 均已注册。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/cli/src/rules.ts:256`
- `packages/cli/src/rules.ts:260`
- `packages/cli/src/rules.ts:268`
- `packages/testkit/src/env.ts:135`

实现片段（位置随框架版本更新）：

```ts

/** CAGE-ORG-001：domain 必须包含框架自带的组织模型 */
/**
 * 确认 domain 注册了 User、Dept、Role 三个框架组织聚合。
 * @param g 当前图。
```
