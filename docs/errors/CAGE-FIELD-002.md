# CAGE-FIELD-002：引用目标为空

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载。

ref 收到空目标，常见原因是循环导入。

## 修复步骤

1. 使用 ref("聚合名") 避免循环求值，确保对应聚合从入口导出且名称正确。

## 正例

```text
deptId: ref('Dept')
```

## 反例

```text
deptId: ref(undefined)
```

## 修复后验证

重跑 cage check/gen，审查契约与迁移；敏感字段还要验证普通用户读结果。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/fields.ts:174`

实现片段（位置随框架版本更新）：

```ts
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-FIELD-002', 'ref() 的目标为空，可能是循环导入；可改为 ref("聚合名")');
  return mk(z.string().uuid(), { kind: 'ref', sql: 'uuid', ref: target });
}

```
