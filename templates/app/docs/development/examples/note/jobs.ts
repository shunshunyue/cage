/**
 * 自动化课程的便笺归档任务，与 note.ts 放在同一领域模块并逐层导出。
 * 每轮用调度器固定 now 找创建超过三十天的 active 记录，最多 200 条，逐条调用现有归档命令。
 * 本课把 archiveNote 的用途明确标为 user/job；各 call 是独立命令事务，失败前已提交的归档不会整批回滚。
 */
import { job } from '@yss123/cage-kernel';
import { Note, archiveNote } from './note.js';

/** 每日 02:00 处理本轮有界候选；时区沿调度环境解释，积压留待后续周期，不能作为一次全量清理保证。 */
export const archiveOldNotes = job('archiveOldNotes', {
  description: '归档创建超过三十天的使用中便笺',
  cron: '0 2 * * *',
  reads: [Note],
  calls: [archiveNote],
  run: async ({ query, call, now }) => {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const records = await query.list(Note, { status: 'active', createdBefore: cutoff }, { limit: 200 });
    for (const record of records) await call(archiveNote, { id: record.id });
  },
});
