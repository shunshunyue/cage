# 建立引用、一对多和多对多关系

关系表达对象之间的业务联系，写在聚合的 fields 中。先判断关系有没有自己的字段和生命周期，再选择表示方式。

## 先选正确的关系

| 业务含义 | 声明 | 写入位置 |
| --- | --- | --- |
| 多条便笺属于同一部门 | ref('Dept') | 便笺自己的命令 |
| 一个用户至多担任一条记录的特定责任人 | ref('User').unique() | 来源对象命令，租户内唯一 |
| 便笺有多条独立评论 | hasMany('NoteComment', { mappedBy: 'noteId' }) | 评论自己的 noteId 外键 |
| 用户可协作多条便笺，便笺可有多人 | manyToMany('User') | 便笺命令修改 ID 集合 |
| 关系有岗位、有效期或审批状态 | 单独的业务聚合 | 关系对象自己的命令 |
| 单据内的一份明细快照 | list(...) | 所属对象字段，非对象关系 |

至多一对一不要求目标一定被引用，也不自动创建目标。集合关系不用 optional/unique/hidden/sensitive；无成员为 []，名称可用 describe 或 options.description。

## 一对多：外键属于子对象

在已有 Note.fields 中追加：

```ts
comments: hasMany('NoteComment', { mappedBy: 'noteId', description: '便笺评论' }),
```

NoteComment 作为独立聚合，声明 noteId: ref('Note')、body、deptId 与 createdBy。mappedBy 必须指向目标上真实存在、引用 Note 的 ref。

创建评论时，命令 input 接收 noteId 和正文，通过 reads: { notes: Note } 读取便笺，确认可见且符合业务状态，再将其部门复制到评论。子对象的授权和范围仍需独立配置；ref 不自动继承父对象范围。

comments 是只读反查，不占 Note 主表列，也不进入可写草稿。移动或创建评论调用评论命令，给 Note 传 comments 数组会被拒绝。

## 多对多：修改来源对象的完整集合

在 Note.fields 中追加：

```ts
members: manyToMany('User', { description: '协作成员' }),
```

框架生成中间表、同租户外键和组合主键。业务命令 input 使用 UUID 数组，handler 返回 members；新建缺省为 []，框架去重、规范化并排序。

替换命令的核心可以是：

```ts
handler: (_draft, input) => ({ members: input.members }),
```

这里 input 必须是业务期望的完整目标集合，[] 表示全部解绑。增量追加可使用草稿中的完整集合拼接新增 ID，让框架去重。不能把当前关联分页结果直接当作全量集合提交，否则会丢失未加载的关联。

新增目标需要调用者具备目标 read 且目标在范围内；源对象命令仍检查自身能力、状态和版本。关联变更与源对象共同事务提交、增加版本并审计，不授予修改目标内容的能力。

双向各声明一个 manyToMany 是两个独立集合，不会自动互为镜像。需要统一关系时，明确由哪一侧维护。

## 单独分页读取关联

生成后使用 note.related.members(id, params) 或 useNoteRelatedMembers(id, params)，评论同理。关系不会在普通 get 响应中自动完整展开。

公开关联同时要求源和目标 read，并通过两侧安全视图落实范围和目标掩码。响应 total 只统计当前可见结果，可能少于真实链接总数；普通源详情也不能推断已加载全体成员。

关联分页、筛选和排序沿用目标字段规则。源对象已删除或不可见时，关联也不能借此绕过源授权。

## 生成和验收

从 domain 入口导出相关聚合及命令，运行 check/gen。审查 ref 外键、唯一索引、自动中间表与迁移草稿，执行新迁移后再用真实账号测试。

覆盖新增、解绑、空集合、重复 ID、目标越权、源越权、版本冲突和分页不覆盖完整集合。删除或更改已部署关系通过新迁移处理，历史迁移保留。

[原语参考](../reference/primitives.md) · [返回开发手册](../README.md)
