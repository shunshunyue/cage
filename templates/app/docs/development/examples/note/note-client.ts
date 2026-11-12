/**
 * 客户端课程的结果、版本与请求幂等示例，放到 Web 的 modules/note 下使用生成契约。
 * 冲突时保留调用方草稿并另取最新结果，不自动覆盖；创建函数保存本次输入和键供明确的同次恢复使用。
 * 本文件不自动重试、不持久保存跨刷新的意图；读取失败与服务端可能已提交都需要页面解释和核对。
 */
import { note, type Note } from '@app/contracts';

/** 使用已读取的版本修改标题；返回冲突和最新读取结果，由页面让用户核对，其他失败保留原错误。 */
export async function renameNote(record: Note, title: string) {
  const result = await note.update(record.id, { title }, record.version);
  if (!result.ok) {
    if (result.code === 'CONFLICT') {
      return { kind: 'conflict' as const, latest: await note.get(record.id) };
    }
    return { kind: 'rejected' as const, error: result };
  }
  return { kind: 'saved' as const, record: result.data };
}

/**
 * 在用户确定输入后创建一次提交意图，返回函数始终复用相同标题和幂等键。
 * 页面需保存这个函数，网络不确定时先核对结果再决定是否恢复同次调用；新意图重新创建。
 * 键只在当前内存中保存，内核回执也有保留期限，不代替跨刷新存储或长期业务去重。
 */
export function prepareNoteCreation(title: string) {
  const input = { title };
  const options = { idempotencyKey: crypto.randomUUID() };
  return () => note.create(input, options);
}
