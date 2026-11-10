# 业务对象之间的关系

[返回学习入口](../README.md) · [最小业务](../reference/primitives.md) · [开发步骤](../getting-started/workflow.md)

关系和普通属性统一写在 `aggregate(...).fields` 中。业务不需要另写 `relations` 区块，也不用为单纯“便笺与用户的关联”创建 `NoteMember` 聚合。

## 选择哪一种声明

| 业务含义 | fields 中的写法 | 数据库如何保存 | 如何修改 |
| --- | --- | --- | --- |
| 多条便笺属于同一部门（多对一） | `deptId: ref('Dept')` | 本表 UUID 外键列 | 所属对象的命令 |
| 一个目标在租户内最多被引用一次（至多一对一） | `reviewerId: ref('User').unique().optional()` | 外键列 + `(tenant_id, reviewer_id)` 唯一索引 | 所属对象的命令；重复引用返回 CONFLICT |
| 一条便笺有多条评论（一对多） | `comments: hasMany('NoteComment', { mappedBy: 'noteId' })` | 外键在评论表的 `noteId: ref('Note')` 上；父表不增加列 | 评论自己的创建/归属命令；父字段只读 |
| 便笺有多个协作人，一个人也能协作多条便笺（多对多） | `members: manyToMany('User', { description: '协作成员' })` | 框架生成中间表、同租户复合外键和组合主键 | 所属便笺的命令返回目标 ID 数组 |
| 一张单据内的 JSON 明细 | `items: list({ sku: text(), qty: int() })` | 主表 JSONB 列 | 所属对象的命令；它不是对象关联 |

`ref().unique()` 表达“至多一个”，不强制目标一定被引用，也不自动创建目标。多对一的每个来源只有一个外键，但多个来源可以填同一目标 ID。一对多需要目标本来就是有业务含义的对象，例如评论、订单行；这种业务对象有自己的字段和命令。

`hasMany` 和 `manyToMany` 是集合关系，不支持 `.optional()`、`.unique()`、`.hidden()` 或 `.sensitive()`。没有关联使用空集合；目标对象的敏感属性由目标自身的权限掩码。可以使用 `.describe()`，也可以在工厂选项中写 `description`。关系不能嵌进 `list`、事件载荷或作为 scope 的部门/创建人字段；事件需要 ID 数组时使用 `list(id())`。

## 完整领域例子

下面可作为 `packages/domain/src/modules/note/note.ts`。它是[最小便笺](../reference/primitives.md)的关系版本，按需要替换原文件，避免重复声明 Note。

```ts
import {
  aggregate, command, fail, hasMany, manyToMany, ref, scope, states, text,
} from '@yss123/cage-kernel';
import { z } from 'zod';

export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    title: text(120),
    deptId: ref('Dept'),
    createdBy: ref('User'),
    // 这是 ID 集合。框架负责物理中间表、约束、关联写入和事务。
    members: manyToMany('User', { description: '协作成员' }),
    // 从评论上的 noteId 反查；这不是一份可写的评论 ID 数组。
    comments: hasMany('NoteComment', { mappedBy: 'noteId', description: '便笺评论' }),
  },
  states: states('active', 'archived', { terminal: ['archived'] }),
  scope: scope.deptSubtree('deptId'),
  invariants: { titleNotBlank: (note) => note.title.trim().length > 0 },
});

export const NoteComment = aggregate('NoteComment', {
  description: '便笺评论',
  fields: {
    noteId: ref('Note'),
    body: text(2000),
    deptId: ref('Dept'),
    createdBy: ref('User'),
  },
  scope: scope.deptSubtree('deptId'),
});

export const createNote = command(Note, {
  name: 'create', from: 'new', to: 'active',
  input: z.object({
    title: z.string().trim().min(1).max(120),
    members: z.array(z.string().uuid()).optional(),
  }),
  // members 不传时由内核初始化为 []；部门与创建人仍按当前身份填入。
  handler: (draft) => draft,
});

export const setNoteMembers = command(Note, {
  name: 'setMembers', from: 'active', to: null,
  input: z.object({ id: z.string().uuid(), members: z.array(z.string().uuid()) }),
  // 完整替换集合；[] 表示全部解绑。只改关系也会递增便笺版本并写审计。
  handler: (_draft, input) => ({ members: input.members }),
});

export const addNoteMembers = command(Note, {
  name: 'addMembers', from: 'active', to: null,
  input: z.object({ id: z.string().uuid(), memberIds: z.array(z.string().uuid()) }),
  // 草稿包含完整的既有关联。增量追加可以保留当前操作者看不到的旧成员。
  // 数组去重与排序由框架统一处理，业务不再维护第二套集合规范化。
  handler: (draft, input) => ({ members: [...draft.members, ...input.memberIds] }),
});

export const createNoteComment = command(NoteComment, {
  name: 'create', from: 'new', to: 'active', reads: { notes: Note },
  input: z.object({ noteId: z.string().uuid(), body: z.string().trim().min(1).max(2000) }),
  handler: async (_draft, input, { notes }) => {
    const note = await notes.get(input.noteId);
    if (!note) return fail('NOTE_NOT_AVAILABLE');
    if (note.status !== 'active') return fail('NOTE_ARCHIVED');
    // 这是“评论沿用便笺部门”的业务规则，必须显式表达，框架不猜测所属关系。
    return { noteId: note.id, body: input.body, deptId: note.deptId };
  },
});
```

在 `modules/note/index.ts` 写 `export * from './note.js';`，再从 domain 的 `index.ts` 保留组织模型及已有模块，导出新模块：

```ts
export * from '@yss123/cage-admin/domain';
export * from './modules/note/index.js';
```

不写双向对象导入时，可用目标聚合名字符串解决循环引用。`mappedBy` 填**目标字段的 TypeScript 名称**，例如 `noteId`；不能填 SQL 列名 `note_id`、目标表名或普通文本字段。目标 ref 需要公开且非敏感，关系接口才能通过目标安全视图反查。

## 页面如何使用

`pnpm gen` 后，生成契约会有以下方法。命令与列表方法的结果仍是 `CageResult`，页面按 `ok/code/domainCode` 处理：

```ts
import {
  note, noteComment, useNoteRelatedMembers, useNoteRelatedComments,
} from '@app/contracts';

// 命令修改关系，第三个参数为详情上看到的版本号，过期版本返回 CONFLICT。
const changed = await note.setMembers(noteId, { members: selectedUserIds }, version);
// 目标是评论对象，不给 hasMany 赋值。
const comment = await noteComment.create({ noteId, body: '已确认需求' });

// 与普通列表一样支持目标字段筛选、分页、排序，单页最多 200 条。
const members = await note.related.members(noteId, { page: 1, pageSize: 20 });
const comments = await note.related.comments(noteId, { page: 1, sort: '-createdAt' });

// React 组件内使用；没有选中 ID 时 hook 不发请求。
const memberQuery = useNoteRelatedMembers(noteId, { page: 1 });
const commentQuery = useNoteRelatedComments(noteId, { page: 1 });
```

上面的 `noteId/selectedUserIds/version` 来自页面的实际选择与详情数据；hook 在 React 组件或自定义 hook 内调用。保存成功后让相关缓存失效，例如 `queryClient.invalidateQueries({ queryKey: ['note', noteId] })`；新增评论还应更新评论列表。框架不自动推断所有跨对象缓存依赖。

自动接口为：

```text
GET /api/note/:id/relations/members
GET /api/note/:id/relations/comments
```

响应是 `{ items, total, page, pageSize }`，items 为**目标对象**的普通快照。`note.get/list` 和命令响应不自动展开成员、评论或完整 ID 集合，避免普通详情无限加载与绕过目标权限。生成的普通 Note 类型也不包含虚拟关系；不能从 `note.get()` 中直接读取 `members`。

## 权限与事务

- 修改成员需要 `Note.setMembers` 或对应增量命令能力，以及便笺范围。新增的用户还必须在调用人的 User 范围内，真人调用需要 `User.read`；范围外或其他租户目标返回 NOT_FOUND，缺能力返回 FORBIDDEN。
- 读取成员需要 `Note.read` 和 `User.read`；读取评论需要 `Note.read` 和 `NoteComment.read`。所属对象不可见返回 NOT_FOUND；目标范围外的数据不计入 items/total。目标敏感字段按其 unmask 能力返回掩码或明文。
- 角色需要分别配置 Note、NoteComment 和 User 的实际数据范围；`hasMany` 不会自动让父对象可见的人看到所有子对象，关系声明本身也不会授予能力。
- 多对多是无序集合。框架统一 UUID 大小写、去重和排序；关联表不保存排列顺序。主表版本、关系增删、审计、outbox 和同事务反应共同提交或回滚。
- 只校验本次新增的目标。某个旧成员后来变为不可见时，只修改标题仍保留其关联；公开分页只返回当前可见目标。页面不能把某一页或可见子集当作完整集合传给 setMembers，否则会解绑未列出的成员；需要保留时使用增量命令。
- `hasMany` 不出现在可写草稿中。输入或 handler 给它赋值会返回 INVALID_INPUT。子对象跨范围或跨租户归属的业务规则要在子命令/约束中明确校验；普通 ref 的行为保持不变，不会继承 manyToMany 的新增目标可见性检查。

## 迁移、图谱与边界

第一次声明 `members` 后执行 `pnpm gen`，会生成 `core.note__members` 草稿。表只保存 `tenant_id/source_id/target_id`，以三列组合主键避免重复；两侧 `(tenant_id, id)` 唯一键与复合外键保证同租户。解绑只删链接，不删除 User；硬删除来源时数据库级联清链接，硬删除被引用目标时外键拒绝。

关系表不注册为业务聚合，不增加独立 CRUD、状态机、审批或角色能力点。`hasMany` 本身不产生新表，只复用目标 ref 已有外键与索引。权限读取通过 `safe.note__members` 和两侧安全视图；业务项目不直接写这些表。

按项目流程运行 `pnpm exec cage check`、`pnpm gen`，审查后 `pnpm migrate`；不要编辑已执行迁移，不会为关系另建一个数据库。删除关系声明后迁移只提示收缩，不自动删除已有链接数据。改变目标类型、把旧 JSON 数组改为关系等操作需要专门的数据迁移；框架不会猜测如何转换历史数据。

`pnpm exec cage graph` 的对象卡片将它们标为“一对多 / 多对多”，集合关系不显示主表列的必填星号。点击连线可看 1:N、N:M、mappedBy 外键位置、中间表名称，以及为什么连接、读写方式。

当前每个 `manyToMany` 字段拥有自己的关系。两边各写一次会生成**两份独立关联**，不会自动成为互为镜像的双向关系；本版没有 manyToMany 的 inverse/mappedBy 选项。需要反向统计时声明 query，列出双方 reads 并查询安全视图。自关联可写 `manyToMany('Note')`，仍是有方向的集合，A 关联 B 不会自动使 B 关联 A。

如果链接本身有职位、参与时间、分摊比例、审批状态等业务属性，它已是有意义的业务对象，应建如“项目任职”的聚合并定义自己的命令，而不是把这些属性塞进自动中间表。关系字段的职责是表达单纯关联。
