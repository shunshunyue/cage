/**
 * 评论课程的纯 handler 测试，与 note-comments.ts 放在同一模块，使用内存只读依赖。
 * 检查父便笺读取、部门复制及已归档/不可见拒绝，不连接数据库或运行完整命令流水线。
 * 权限、外键、事务、审计和并发需要另做真实 PostgreSQL 集成与业务验收。
 */
import { expect, it } from 'vitest';
import { draftOf, fakeRepo, handlerCtx } from '@yss123/cage-testkit';
import { Note, createNote } from './note.js';
import { createNoteComment } from './note-comments.js';

it('评论使用中便笺时复制父对象部门', async () => {
  const parent = draftOf(createNote, { status: 'active', title: '部门纪要' });
  const input = createNoteComment.input.parse({ noteId: parent.id, body: '补充事项' });
  const result = await createNoteComment.handler(
    draftOf(createNoteComment), input,
    { notes: fakeRepo<typeof Note>([parent]) }, handlerCtx(),
  );
  expect(result).toMatchObject({ noteId: parent.id, body: '补充事项', deptId: parent.deptId });
});

it('读到已归档父便笺时拒绝评论', async () => {
  const parent = draftOf(createNote, { status: 'archived', title: '历史纪要' });
  const input = createNoteComment.input.parse({ noteId: parent.id, body: '补充事项' });
  const result = await createNoteComment.handler(
    draftOf(createNoteComment), input,
    { notes: fakeRepo<typeof Note>([parent]) }, handlerCtx(),
  );
  expect(result).toMatchObject({ code: 'NOTE_ARCHIVED' });
});

it('父便笺未命中时返回不可读取，不伪造部门', async () => {
  const parent = draftOf(createNote);
  const input = createNoteComment.input.parse({ noteId: parent.id, body: '补充事项' });
  const result = await createNoteComment.handler(
    draftOf(createNoteComment), input,
    { notes: fakeRepo<typeof Note>([]) }, handlerCtx(),
  );
  expect(result).toMatchObject({ code: 'NOTE_NOT_READABLE' });
});
