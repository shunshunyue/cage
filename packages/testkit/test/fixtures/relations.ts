// 关系回归领域：便笺归属于便笺本，协作成员直接声明在 fields，不手写中间表聚合。
import {
  aggregate, command, emit, event, fail, hasMany, id, manyToMany, reaction, ref, scope, text,
} from '@yss123/cage-kernel';
import { z } from 'zod';
export * from '@yss123/cage-admin/domain';

export const Notebook = aggregate('Notebook', {
  description: '便笺本',
  fields: { title: text(120), createdBy: ref('User'), notes: hasMany('Note', { mappedBy: 'notebookId', description: '本内便笺' }) },
  scope: scope.self(),
});

export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    title: text(120), deptId: ref('Dept'), createdBy: ref('User'),
    notebookId: ref('Notebook').optional(),
    reviewerId: ref('User').unique().optional(),
    members: manyToMany('User', { description: '协作成员' }),
    // 自关联也由同一套机制处理，不依赖两个不同主表。
    relatedNotes: manyToMany('Note', { description: '相关便笺' }),
  },
  scope: scope.deptSubtree('deptId'),
  invariants: { membersUnique: (note) => new Set(note.members).size === note.members.length },
});

export const createNotebook = command(Notebook, {
  name: 'create', from: 'new', to: 'active', input: z.object({ title: z.string() }), handler: (draft) => draft,
});
export const createNote = command(Note, {
  name: 'create', from: 'new', to: 'active',
  input: z.object({ title: z.string(), members: z.array(z.string().uuid()).optional(), relatedNotes: z.array(z.string().uuid()).optional(), notebookId: z.string().uuid().optional() }),
  handler: (draft) => draft,
});
export const setMembers = command(Note, {
  from: 'active', to: null,
  input: z.object({ id: z.string().uuid(), members: z.array(z.string().uuid()) }),
  handler: (_draft, input) => ({ members: input.members }),
});
export const setRelatedNotes = command(Note, {
  from: 'active', to: null, input: z.object({ id: z.string().uuid(), relatedNotes: z.array(z.string().uuid()) }),
  handler: (_draft, input) => ({ relatedNotes: input.relatedNotes }),
});
export const renameNote = command(Note, {
  name: 'rename', from: 'active', to: null, input: z.object({ id: z.string().uuid(), title: z.string() }),
  handler: (_draft, input) => ({ title: input.title }),
});
export const moveNote = command(Note, {
  name: 'move', from: 'active', to: null, input: z.object({ id: z.string().uuid(), notebookId: z.string().uuid() }),
  handler: (_draft, input) => ({ notebookId: input.notebookId }),
});

export const MembersChanged = event('MembersChanged', { noteId: id() });
export const failAfterMemberChange = command(Note, {
  from: 'active', to: null, input: setMembers.input, emits: [emit(MembersChanged, (note) => ({ noteId: note.id }))],
  handler: (_draft, input) => ({ members: input.members }),
});
export const rejectChange = command(Note, { from: 'active', to: null, invokedBy: 'process', handler: () => fail('CHANGE_REJECTED') });
export const rejectChangedMembers = reaction(MembersChanged, { command: rejectChange, tx: 'same', map: (ev) => ({ id: ev.noteId }) });

// 证明读取依赖的 get/find/findOne 得到同样的完整 ID 集合；业务可据此计算变化。
export const copyMembers = command(Note, {
  from: 'active', to: null, reads: { notes: Note },
  input: z.object({ id: z.string().uuid(), sourceId: z.string().uuid(), mode: z.enum(['get', 'find', 'findOne']) }),
  handler: async (_draft, input, { notes }) => {
    const source = input.mode === 'get' ? await notes.get(input.sourceId)
      : input.mode === 'find' ? (await notes.find({ id: input.sourceId }))[0] : await notes.findOne({ id: input.sourceId });
    return source ? { members: source.members } : fail('SOURCE_MISSING');
  },
});
