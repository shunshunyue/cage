/**
 * 关系课程的便笺评论，放到应用 modules/note 并从该模块及 domain 总入口导出。
 * 评论有自己的身份、正文和归属；创建时通过 reads 读取父便笺，复制部门并拒绝已归档的快照。
 * Note.fields 还需按课程增加 comments 反查；读取父对象不加更新锁，不承诺与并发归档互斥。
 */
import { aggregate, command, fail, ref, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';
import { Note } from './note.js';

/** 评论独立持久化并按部门和创建人参与范围判断；引用不会自动继承父对象权限。 */
export const NoteComment = aggregate('NoteComment', {
  description: '便笺评论',
  fields: {
    /** 父便笺的 UUID，由创建命令检查，供 Note.comments 通过 mappedBy 反查。 */
    noteId: ref('Note').describe('所属便笺'),
    /** 去除首尾空白后的正文，最多 1000 字符；空内容在输入校验时拒绝。 */
    body: text(1000).describe('评论正文'),
    /** 从当前父便笺复制，不允许客户端任意选择评论部门。 */
    deptId: ref('Dept').describe('所属部门'),
    /** 内核按当前真人主体设置，支持评论自己的本人范围。 */
    createdBy: ref('User').describe('评论人'),
  },
  states: states('active', { terminal: ['active'], labels: { active: '已发表' } }),
  scope: scope.deptSubtree('deptId'),
});

/**
 * 创建评论，只接收父便笺 UUID 与正文；父对象不可见或读到已归档状态时业务拒绝。
 * reads 绑定本次事务的只读依赖，返回部门补丁后由内核完成评论范围、引用、审计与提交。
 * 父记录读取没有更新锁，严格禁止并发归档与评论交错的业务需要额外的一致性设计。
 */
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
