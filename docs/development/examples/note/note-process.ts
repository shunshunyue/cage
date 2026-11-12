/**
 * 本体课程的可选阅读流程，放到 workflows/note-process.ts 并从 domain 总入口导出。
 * 引用真实创建和归档命令解释人工主线，不创建运行调度、额外权限或新的业务状态。
 * 简单便笺可不使用此规格；此文件只演示确需流程阅读板块时怎样连接已有声明。
 */
import { businessProcess } from '@yss123/cage-kernel';
import { Note, archiveNote, createNote } from '../modules/note/index.js';

/** 创建后由有权用户归档，结束阶段引用实际归档命令，执行条件继续由领域实现决定。 */
export const noteLifecycle = businessProcess('note-lifecycle', {
  title: '便笺生命周期',
  description: '说明便笺创建与人工归档的阅读主线',
  area: { id: 'collaboration', title: '部门协作', description: '部门内资料协作与保留' },
  subject: Note,
  entry: 'create',
  stages: {
    create: { title: '创建便笺', description: '保存标题和归属', actor: '有创建能力的用户', action: createNote },
    archive: { title: '归档保留', description: '保留历史并关闭编辑', kind: 'end', action: archiveNote },
  },
  transitions: [{ from: 'create', to: 'archive', mode: 'manual', label: '有权用户决定归档' }],
});
