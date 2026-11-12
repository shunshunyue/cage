# CAGE-GRANT-002：授予超出自己的数据范围

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：组织命令。

设置范围或分配角色时，目标范围比操作人自身范围更宽。

## 修复步骤

1. 核对操作人在该聚合的范围，由具有足够范围的管理员配置；部门限定还需对应范围字段。

## 正例

```text
自己有 all 范围时，按业务需求授予部门范围
```

## 反例

```text
仅有本人范围的管理员给角色授予全部部门
```

## 修复后验证

用真实操作人验证允许与拒绝场景，检查目标角色最终能力、参数和范围。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/admin/src/domain/constraints.ts:105`
- `packages/admin/src/domain/constraints.ts:128`

实现片段（位置随框架版本更新）：

```ts
    const want = COMBINATOR_WIDTH[input.combinator as Combinator] ?? 99;
    return want <= ownWidth(ctx, input.aggregate) ? ok() : violation('[CAGE-GRANT-002] 不能授出比自己更宽的数据范围');
  },
});

```
