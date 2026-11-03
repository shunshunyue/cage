# CAGE-REL-001：关系字段声明无效

[返回错误码册](README.md) · [业务排错](../ai/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明加载 / 生成。

关系目标未导出、hasMany.mappedBy 不是指回当前聚合的公开 ref、关系表重名/过长，或集合关系用于不支持的位置与修饰。带关系聚合的用户命令名 related 也会占用生成客户端入口。

## 修复步骤

1. 把 ref/hasMany/manyToMany 的目标从 domain 入口导出；循环引用使用聚合名字符串。
2. hasMany 的 mappedBy 写目标上的真实 ref 字段名，该字段不能 hidden 或 sensitive；修改归属调用子对象命令。
3. 集合关系只写在聚合 fields 中，不放进 list、事件载荷或 scope 字段。不要对关系链式调用 optional/unique/hidden/sensitive；没有关联用空集合表示。
4. 缩短或调整发生冲突的字段/表名；业务命令避开 related，运行 cage check/gen 后审查迁移。

## 正例

```text
Note.fields.members = manyToMany('User', { description: '协作成员' }); // User 已导出
Notebook.fields.notes = hasMany('Note', { mappedBy: 'notebookId' }); // Note.notebookId = ref('Notebook')
```

## 反例

```text
hasMany('Note', { mappedBy: 'title' }); // title 不是反向 ref
list({ members: manyToMany('User') }); // JSON 明细中不能声明关系
```

## 修复后验证

重跑 cage check/gen；迁移后用真实用户验证关系命令、关联分页读取和双侧范围。不要手写纯中间表聚合。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/kernel/src/primitives/aggregate.ts:97`
- `packages/kernel/src/primitives/event.ts:20`
- `packages/kernel/src/primitives/fields.ts:105`
- `packages/kernel/src/primitives/fields.ts:111`
- `packages/kernel/src/primitives/fields.ts:118`
- `packages/kernel/src/primitives/fields.ts:124`
- `packages/kernel/src/primitives/fields.ts:181`
- `packages/kernel/src/primitives/fields.ts:188`
- `packages/kernel/src/primitives/fields.ts:224`
- `packages/kernel/src/registry.ts:146`
- `packages/kernel/src/registry.ts:150`
- `packages/kernel/src/registry.ts:156`
- `packages/kernel/src/registry.ts:164`

实现片段（位置随框架版本更新）：

```ts
    if (f && f !== 'id' && !(f in fields)) throw declError('CAGE-SCOPE-002', `${name} 的范围字段 ${f} 不存在`);
    if (f && f !== 'id' && isRelation(fields[f])) throw declError('CAGE-REL-001', `${name} 的范围字段必须是主表列，不能使用集合关系 ${f}`);
    if (f && f !== 'id' && isFile(fields[f])) throw declError('CAGE-FILE-001', `${name} 的范围字段不能使用文件 ${f}`);
  }
  const scope: ScopeSpec = Object.freeze({ ...sc, ownerField });
```
