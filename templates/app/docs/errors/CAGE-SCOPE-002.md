# CAGE-SCOPE-002：范围字段没有声明

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明 / 范围编译。

aggregate.scope 指向的部门或创建人字段不存在。

## 修复步骤

1. 在聚合声明真实字段，或改用正确字段名。scope.none 表示无此类字段，不代表不限权限。

## 正例

```text
fields: { deptId: ref('Dept') }, scope: scope.deptSubtree('deptId')
```

## 反例

```text
scope.deptSubtree('departmentId')，fields 只有 deptId
```

## 修复后验证

重跑 cage check；分别使用本人/部门等实际授权用户验证范围内外结果。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/aggregate.ts:187`

实现片段（位置随框架版本更新）：

```ts
  for (const f of [sc.deptField, ownerField]) {
    if (f && f !== 'id' && !(f in fields)) throw declError('CAGE-SCOPE-002', `${name} 的范围字段 ${f} 不存在`);
    if (f && f !== 'id' && isRelation(fields[f])) throw declError('CAGE-REL-001', `${name} 的范围字段必须是主表列，不能使用集合关系 ${f}`);
    if (f && f !== 'id' && isFile(fields[f])) throw declError('CAGE-FILE-001', `${name} 的范围字段不能使用文件 ${f}`);
  }
```
