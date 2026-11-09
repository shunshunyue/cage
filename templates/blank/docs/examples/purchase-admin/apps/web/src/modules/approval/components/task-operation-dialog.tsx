/**
 * 人工待办的转办、委派和三种加签操作表单，由审批收件箱按当前任务快照打开。
 * 选择来自业务协作名录，提交携带任务 revision 和必填原因；权限/同节点重复责任由引擎重查。
 * 失败保留选人和原因；成功刷新真实任务并关闭。等待/受托任务不从页面打开本表单，不在前端改流程状态。
 */
import { useState, type FormEvent } from 'react';
import { client } from '@app/contracts';
import type { ApprovalTask, ApprovalTaskAction } from '@yss123/cage-client';
import { ApprovalMemberPicker } from '../../../shared/ui/approval-member-picker';
import { errorMessage } from '../../../shared/lib/error-message';
import { useQueryClient } from '@tanstack/react-query';

/** 页面允许发起的人员管理操作，归还/领取/释放在任务行直接处理。 */
export type PersonnelOperation = 'transfer' | 'delegate' | 'parallel' | 'before' | 'after';
/** 业务名称与引擎 placement 对应；不引入额外执行步骤或暗示自动授予权限。 */
const labels = { transfer: '转办审批', delegate: '委派协助', parallel: '并行加签', before: '前加签', after: '后加签' } as const;
const descriptions = {
  transfer: '将这项审批责任交给另一位人员，你将不再处理此任务。',
  delegate: '请他人核对材料，受托人归还后仍由你决定。',
  parallel: '你与新增人员可以同时处理，所有追加意见都是必签。',
  before: '先请新增人员签署，全部完成后这项任务才回到你手中。',
  after: '你先签署，随后激活新增人员的必签任务。',
};

/**
 * task 与 operation 在打开时固定；任务变化以服务端冲突响应为准，不自动改用新版本重试。
 * close 返回当前收件箱，成功通过查询缓存刷新；无效输入禁用提交，Esc/取消不产生写入。
 */
export function TaskOperationDialog({ task, operation, close }: { task: ApprovalTask; operation: PersonnelOperation; close: () => void }) {
  const [userIds, setUserIds] = useState<string[]>([]), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const cache = useQueryClient();
  const single = operation === 'transfer' || operation === 'delegate';
  /**
   * 将人员选择映射为对应动作；每次携带打开弹窗时的 revision，旧任务冲突时保留输入供用户核对。
   * 只在服务端确认成功后刷新并关闭，不能把选中人员或提交请求本身视为已经完成交接。
   */
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !userIds.length || !reason.trim()) return;
    setBusy(true); setError('');
    const input: ApprovalTaskAction = single
      ? { action: operation, targetUserId: userIds[0], reason, expectedRevision: task.revision }
      : { action: 'addSign', placement: operation, userIds, reason, expectedRevision: task.revision };
    const result = await client.approvalTaskAction(task.id, input);
    setBusy(false);
    if (!result.ok) { setError(errorMessage(result)); return; }
    await cache.invalidateQueries(); close();
  }
  return <div className="modal-backdrop"><section className="modal approval-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-operation-title"
    onKeyDown={event => { if (event.key === 'Escape' && !busy) close(); }}>
    <div className="section-head"><div><h2 id="approval-operation-title">{labels[operation]}</h2><p className="muted">{task.title}</p></div>
      <button type="button" disabled={busy} onClick={close} aria-label="关闭操作">×</button></div>
    <form onSubmit={submit}><p>{descriptions[operation]}</p>
      <ApprovalMemberPicker value={userIds} onChange={setUserIds} max={single ? 1 : 20} exclude={[task.assigneeId, task.ownerId].filter((id): id is string => !!id)} disabled={busy} />
      <label>操作原因<textarea autoFocus rows={3} maxLength={1000} required value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="说明业务原因，供单据参与者查看" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions"><button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !userIds.length || !reason.trim()}>{busy ? '提交中…' : `确认${labels[operation]}`}</button></div>
    </form>
  </section></div>;
}
