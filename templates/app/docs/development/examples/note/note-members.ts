/**
 * 关系课程的便笺成员替换命令，与 note.ts 放在同一领域模块并逐层导出。
 * 前提是 Note.fields 已增加 manyToMany('User') 的 members；输入代表完整目标集合，不接受分页快照替代全量。
 * 内核负责新增目标可见性、关系事务、版本和审计，声明不会授予成员或操作者额外业务权限。
 */
import { command } from '@yss123/cage-kernel';
import { z } from 'zod';
import { Note } from './note.js';

/** 替换 active 便笺的全部协作成员，最多 50 个 UUID；空数组解绑全部，重复 ID 由框架规范化。 */
export const setNoteMembers = command(Note, {
  name: 'setMembers',
  description: '替换便笺协作成员',
  from: 'active',
  to: null,
  input: z.object({ id: z.uuid(), members: z.array(z.uuid()).max(50) }),
  handler: (_draft, input) => ({ members: input.members }),
});
