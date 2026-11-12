/**
 * 自动化课程的归档事件、归档记录与同事务反应，放到 modules/note 并逐层导出。
 * note.ts 的归档命令需按课程显式 emit 本事件；反应调用另一个聚合的命令，记录失败会回滚这次归档。
 * 本例不占用资源、不发送外部请求；事件是发生的事实，反应声明本身不执行持久化。
 */
import { aggregate, command, event, id, reaction, ref, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

/** 归档成功后的标题与部门快照；noteId 显式映射，避免依赖多个 ID 字段的默认推断。 */
export const NoteArchived = event('NoteArchived', {
  /** 已归档便笺 UUID，不是新建归档记录的主键。 */
  noteId: id().describe('便笺标识'),
  /** 归档时的标题，后续外部映射只发送本例明确允许的这个字段。 */
  title: text(120).describe('归档标题'),
  /** 归档时的部门，用于归档记录自己的数据范围。 */
  deptId: id().describe('所属部门'),
}, { description: '便笺已归档' });

/** 每次归档生成独立记录，保存当时标题与部门；它有自己的读取能力和范围。 */
export const NoteArchiveLog = aggregate('NoteArchiveLog', {
  description: '便笺归档记录',
  fields: {
    /** 指向发生归档的便笺，记录自己仍使用内核生成的新 UUID。 */
    noteId: ref('Note').describe('所属便笺'),
    /** 归档事件中的标题快照，不随其他对象字段自动更新。 */
    title: text(120).describe('归档标题'),
    /** 来自事件的部门，支持归档记录自己的部门范围。 */
    deptId: ref('Dept').describe('所属部门'),
  },
  states: states('active', { terminal: ['active'], labels: { active: '已记录' } }),
  scope: scope.deptSubtree('deptId'),
});

/** 只供 process 反应创建归档记录；显式校验事件映射输入，草稿仍经过字段、范围、审计与事务检查。 */
export const recordNoteArchive = command(NoteArchiveLog, {
  name: 'record',
  description: '记录便笺归档事实',
  from: 'new',
  to: 'active',
  invokedBy: 'process',
  input: z.object({ noteId: z.uuid(), title: z.string().min(1).max(120), deptId: z.uuid() }),
  handler: (draft) => draft,
});

/** 同事务写入归档记录；map 为纯字段映射，任一目标校验或写入失败都回滚归档主事务。 */
export const logNoteArchive = reaction(NoteArchived, {
  command: recordNoteArchive,
  tx: 'same',
  map: (event) => ({ noteId: event.noteId, title: event.title, deptId: event.deptId }),
});
