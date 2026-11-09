// 关系回归领域：便笺归属于便笺本，协作成员直接声明在 fields，不手写中间表聚合。
import {
  aggregate, command, emit, event, fail, hasMany, id, manyToMany, reaction, ref, scope, text,
} from '@yss123/cage-kernel';
import { z } from 'zod';
/** 关系目标包含真实 User，关联目标的能力、部门范围和敏感字段均由框架读侧验证。 */
export * from '@yss123/cage-admin/domain';

/** title 为本名，createdBy 决定本人范围；notes 反查 Note.notebookId，不创建可写主表列。 */
export const Notebook = aggregate('Notebook', {
  description: '便笺本',
  fields: { title: text(120), createdBy: ref('User'), notes: hasMany('Note', { mappedBy: 'notebookId', description: '本内便笺' }) },
  scope: scope.self(),
});

/** 部门便笺同时承载可空外键、唯一引用、多对多和自关联，覆盖不同关系的存储及授权边界。 */
export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    /** 标题最长 120 字；deptId 控制部门范围，createdBy 由内核填充并提供本人范围。 */
    title: text(120), deptId: ref('Dept'), createdBy: ref('User'),
    /** 可不归属任何便笺本；移动归属必须通过子对象命令更新此实际外键。 */
    notebookId: ref('Notebook').optional(),
    /** 可空且唯一的审阅人引用，用真实索引验证至多一对一。 */
    reviewerId: ref('User').unique().optional(),
    /** 用户 ID 集合由自动中间表保存；普通对象响应不直接暴露完整内部 ID 列表。 */
    members: manyToMany('User', { description: '协作成员' }),
    // 自关联也由同一套机制处理，不依赖两个不同主表。
    relatedNotes: manyToMany('Note', { description: '相关便笺' }),
  },
  scope: scope.deptSubtree('deptId'),
  invariants: { membersUnique: (note) => new Set(note.members).size === note.members.length },
});

/** 只接收本名，hasMany 的 notes 不能从父命令输入伪造成可写关系。 */
export const createNotebook = command(Notebook, {
  name: 'create', from: 'new', to: 'active', input: z.object({ title: z.string() }), handler: (draft) => draft,
});
/** 创建时接收可选关联 ID 集合和归属外键，省略集合初始化为空；目标存在性与授权由关系绑定检查。 */
export const createNote = command(Note, {
  name: 'create', from: 'new', to: 'active',
  input: z.object({ title: z.string(), members: z.array(z.string().uuid()).optional(), relatedNotes: z.array(z.string().uuid()).optional(), notebookId: z.string().uuid().optional() }),
  handler: (draft) => draft,
});
/** 完整替换成员集合，用于去重、清空、版本冲突和同键回放断言。 */
export const setMembers = command(Note, {
  from: 'active', to: null,
  input: z.object({ id: z.string().uuid(), members: z.array(z.string().uuid()) }),
  handler: (_draft, input) => ({ members: input.members }),
});
/** 替换同聚合关联，可关联自己；解绑只移除中间表关系，不删除目标便笺。 */
export const setRelatedNotes = command(Note, {
  from: 'active', to: null, input: z.object({ id: z.string().uuid(), relatedNotes: z.array(z.string().uuid()) }),
  handler: (_draft, input) => ({ relatedNotes: input.relatedNotes }),
});
/** 无关字段更新应保留已有关系，即使旧目标刚移出调用者当前可见范围。 */
export const renameNote = command(Note, {
  name: 'rename', from: 'active', to: null, input: z.object({ id: z.string().uuid(), title: z.string() }),
  handler: (_draft, input) => ({ title: input.title }),
});
/** 更新真实 notebookId 外键，两个便笺本的 hasMany 反查随之变化，无需手写父集合更新。 */
export const moveNote = command(Note, {
  name: 'move', from: 'active', to: null, input: z.object({ id: z.string().uuid(), notebookId: z.string().uuid() }),
  handler: (_draft, input) => ({ notebookId: input.notebookId }),
});

/** 仅携带当前便笺 ID，触发用于回滚断言的后置失败反应。 */
export const MembersChanged = event('MembersChanged', { noteId: id() });
/** 先提出成员替换再发事件，模拟跨步骤事务最后失败；不能只断言异常而忽略中间表恢复。 */
export const failAfterMemberChange = command(Note, {
  from: 'active', to: null, input: setMembers.input, emits: [emit(MembersChanged, (note) => ({ noteId: note.id }))],
  handler: (_draft, input) => ({ members: input.members }),
});
/** 固定业务失败命令，保持 process 来源以真实走反应调用入口。 */
export const rejectChange = command(Note, { from: 'active', to: null, invokedBy: 'process', handler: () => fail('CHANGE_REJECTED') });
/** 同事务连接失败命令，使主表、关系、成功审计和 outbox 全部回滚。 */
export const rejectChangedMembers = reaction(MembersChanged, { command: rejectChange, tx: 'same', map: (ev) => ({ id: ev.noteId }) });

// 证明读取依赖的 get/find/findOne 得到同样的完整 ID 集合；业务可据此计算变化。
/** sourceId 定位来源便笺，mode 选择读仓储方法；目标不存在返回 SOURCE_MISSING，存在则复制完整内部成员集合。 */
export const copyMembers = command(Note, {
  from: 'active', to: null, reads: { notes: Note },
  input: z.object({ id: z.string().uuid(), sourceId: z.string().uuid(), mode: z.enum(['get', 'find', 'findOne']) }),
  handler: async (_draft, input, { notes }) => {
    const source = input.mode === 'get' ? await notes.get(input.sourceId)
      : input.mode === 'find' ? (await notes.find({ id: input.sourceId }))[0] : await notes.findOne({ id: input.sourceId });
    return source ? { members: source.members } : fail('SOURCE_MISSING');
  },
});
