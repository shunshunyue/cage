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

例如“一个用户至多担任一条记录的专属责任人”写成唯一引用；用户是否有对应记录仍需另查，引用不会反向自动创建：

<!-- cage:check domain relation-unique-reference -->
```ts
export const exclusiveOwner = ref('User').unique().describe('专属责任人');
```

若关系自己还有有效期和岗位，便是独立的任职对象；例如任职记录有 userId、noteId、role、validUntil，而不是往 manyToMany 的 UUID 数组里夹任职详情。

## 一对多：外键属于子对象

以[便笺课程](../getting-started/first-feature.md)为基础，在 note.ts 的 kernel import 中补 hasMany、manyToMany，再向 Note.fields 追加：

<!-- cage:example note-relations-fields -->
```ts
comments: hasMany('NoteComment', { mappedBy: 'noteId', description: '便笺评论' }),
members: manyToMany('User', { description: '协作成员' }),
```

NoteComment 作为独立聚合，声明 noteId: ref('Note')、body、deptId 与 createdBy。mappedBy 必须指向目标上真实存在、引用 Note 的 ref。

创建评论时，命令 input 接收 noteId 和正文，通过 reads: { notes: Note } 读取便笺，确认可见且符合业务状态，再将其部门复制到评论。子对象的授权和范围仍需独立配置；ref 不自动继承父对象范围。

将[评论完整文件](../examples/note/note-comments.ts)放到同一模块的 note-comments.ts，并逐层导出。它包含 NoteComment 聚合、import 和下面这个创建命令：

<!-- cage:example create-note-comment -->
```ts
export const createNoteComment = command(NoteComment, {
  name: 'create',
  description: '评论使用中的便笺',
  from: 'new',
  to: 'active',
  input: z.object({ noteId: z.uuid(), body: z.string().trim().min(1).max(1000) }),
  reads: { notes: Note },
  handler: async (_draft, input, deps) => {
    const parent = await deps.notes.get(input.noteId);
    if (!parent) return fail('NOTE_NOT_READABLE', '无法读取所属便笺');
    if (parent.status !== 'active') return fail('NOTE_ARCHIVED', '已归档便笺不能评论');
    return { noteId: input.noteId, body: input.body, deptId: parent.deptId };
  },
});
```

fail 会使本次评论创建回滚；deps.notes.get 不取得父记录更新锁，因此上述检查针对读到的快照。需要严格防止并发归档与评论交错时，另行设计一致性边界。

comments 是只读反查，不占 Note 主表列，也不进入可写草稿。移动或创建评论调用评论命令，给 Note 传 comments 数组会被拒绝。

## 多对多：修改来源对象的完整集合

框架生成中间表、同租户外键和组合主键。业务命令 input 使用 UUID 数组，handler 返回 members；新建缺省为 []，框架去重、规范化并排序。

已有上面的 members 字段后，将[成员命令完整文件](../examples/note/note-members.ts)放到同一模块并导出：

<!-- cage:example set-note-members -->
```ts
export const setNoteMembers = command(Note, {
  name: 'setMembers',
  description: '替换便笺协作成员',
  from: 'active',
  to: null,
  input: z.object({ id: z.uuid(), members: z.array(z.uuid()).max(50) }),
  handler: (_draft, input) => ({ members: input.members }),
});
```

这里 input 必须是业务期望的完整目标集合，[] 表示全部解绑。增量追加可使用草稿中的完整集合拼接新增 ID，让框架去重。不能把当前关联分页结果直接当作全量集合提交，否则会丢失未加载的关联。

例如“新增一个成员”应基于命令草稿里的完整集合，并继续保留最多 50 人的规则：

<!-- cage:check domain relation-add-member -->
```ts
export const addMember = command(Note, {
  name: 'addMember', description: '新增便笺成员并保留原集合', from: 'active', to: null,
  input: z.object({ id: z.uuid(), userId: z.uuid() }),
  handler: (draft, input) => {
    const members = [...new Set([...draft.members, input.userId])];
    return members.length > 50 ? fail('MEMBERS_LIMIT', '最多 50 位成员') : { members };
  },
});
```

新增目标需要调用者具备目标 read 且目标在范围内；源对象命令仍检查自身能力、状态和版本。关联变更与源对象共同事务提交、增加版本并审计，不授予修改目标内容的能力。

双向各声明一个 manyToMany 是两个独立集合，不会自动互为镜像。需要统一关系时，明确由哪一侧维护。

例如 Note.members 链接甲，并不自动让另一个 User.notes 集合也包含这条便笺。关系只有一份事实时，应统一维护来源侧，而不是期待两套中间表互相同步。

## 单独分页读取关联

生成后使用 note.related.members(id, params) 或 useNoteRelatedMembers(id, params)，评论同理。关系不会在普通 get 响应中自动完整展开。

下面是 Web 模块中可直接使用的完整调用片段，三个方法都返回 CageResult，页面分别检查 ok 后取 data：

<!-- cage:example relation-client -->
```ts
import { note, noteComment, type Note } from '@app/contracts';

/** 独立读取关联第一页，保留两个结果各自的成功或失败，不把一页当全量集合。 */
export async function loadNoteRelations(id: string) {
  const members = await note.related.members(id, { page: 1, pageSize: 20 });
  const comments = await note.related.comments(id, { page: 1, pageSize: 20 });
  return { members, comments };
}

/** 创建评论，noteId 指向便笺；正文、父状态与部门由服务端继续校验。 */
export const commentOnNote = (id: string, body: string) => noteComment.create({ noteId: id, body });

/** desiredIds 来自用户确认的完整目标集合，不能直接使用上面第一页成员的 IDs。 */
export const replaceNoteMembers = (record: Note, desiredIds: string[]) =>
  note.setMembers(record.id, { members: desiredIds }, record.version);
```

公开关联同时要求源和目标 read，并通过两侧安全视图落实范围和目标掩码。响应 total 只统计当前可见结果，可能少于真实链接总数；普通源详情也不能推断已加载全体成员。

例如便笺实际有 50 位成员，当前用户只可读取其中 5 位，关联 total 可以是 5。拿这 5 位去调用完整替换，会删除其余链接；读取结果不是完整编辑清单。

关联分页、筛选和排序沿用目标字段规则。源对象已删除或不可见时，关联也不能借此绕过源授权。

## 生成和验收

从 domain 入口导出相关聚合及命令，运行 check/gen。审查 ref 外键、唯一索引、自动中间表与迁移草稿，执行新迁移后再用真实账号测试。

覆盖新增、解绑、空集合、重复 ID、目标越权、源越权、版本冲突和分页不覆盖完整集合。删除或更改已部署关系通过新迁移处理，历史迁移保留。

例如先设 [甲, 乙]，再设 [乙, 乙]，最终应只有乙；传 [] 后关联为空。另一次用旧 version 替换应冲突，新增不可读取的用户应被拒绝，而不是悄悄丢掉该 ID。

[原语参考](../reference/primitives.md) · [返回开发手册](../README.md)
