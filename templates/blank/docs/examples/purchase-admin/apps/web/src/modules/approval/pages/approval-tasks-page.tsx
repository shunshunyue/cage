/**
 * 审批收件箱使用 URL 的 view 切换本人、可领取和等待加签任务，刷新/前进后退保留视图。
 * 通过 app 注入详情链接，界面调用客户端完成领取、释放、人员流转与决定；候选身份和版本仍由服务端校验。
 * 原因是行内临时草稿，动作成功后由 useCommand 失效查询并重读；waiting 仅供查看，不显示决定入口。
 */
import { useState } from 'react';
import { client } from '@app/contracts';
import type { ApprovalTask } from '@yss123/cage-client';
import { Link, useSearchParams } from 'react-router-dom';
import { useCommand, type RunCommand } from '../../../shared/hooks/use-command';
import { Notice } from '../../../shared/ui/notice';
import { PageHeading } from '../../../shared/ui/page-heading';
import { useApprovalTasks } from '../hooks/use-approval-tasks';
import { AssistantPage } from '../../../shared/ui/assistant-scope';
import './approval-tasks.css';
import { TaskOperationDialog, type PersonnelOperation } from '../components/task-operation-dialog';

/** 三种任务视图进入查询参数；只有 pending 会计入原有导航待办数。 */
const views = { pending: '待我处理', candidates: '可领取', waiting: '等待加签' } as const;

/**
 * 为一项任务展示顺序、意见和合法阶段入口。busy 来自整页，提交时防止同页重复操作。
 * 领取/释放/委派归还必须人工填写原因；决定意见可选。每次都提交当前 revision，失败保留草稿供核对。
 * @param task 服务端安全摘要；assigneeId 为空表示尚未领取，不可直接批准。
 * @param orderUrl app 组合的详情 URL 生成器，不访问其他业务模块内部。
 * @param run 统一结果/缓存处理；此组件不乐观修改任务或赋予权限。
 */
function TaskRow({ task, orderUrl, busy, run }: { task: ApprovalTask; orderUrl: (id: string) => string; busy: boolean; run: RunCommand }) {
  const [reason, setReason] = useState('');
  const [operation, setOperation] = useState<PersonnelOperation | null>(null);
  const waiting = task.status === 'waiting';
  const candidate = task.assigneeId === null;
  const delegated = task.delegation === 'pending';
  const manage = (action: 'claim' | 'unclaim' | 'resolve', success: string) => run(
    () => client.approvalTaskAction(task.id, { action, expectedRevision: task.revision, reason }), success);
  const position = task.signPosition === 'before' ? '前签' : task.signPosition === 'after' ? '后签' : task.taskKind === 'additional' ? '并行加签' : null;
  return (
    <div className="task">
      <div className="approval-task-summary">
        <h3>{task.title}{position && <small className="muted"> · {position}</small>}</h3>
        {!!task.branchPath?.length && <p className="muted">{task.branchPath.map(part => `${part.parallel} · ${part.branch}`).join(' / ')}</p>}
        <p className="mono muted">PO-{task.businessKey.slice(0, 8).toUpperCase()}</p>
        <p className="muted">金额 ¥{String(task.vars.amount ?? '—')}{task.vars.needsSpecialistReview === true ? ' · 含专业会签' : ''}</p>
        <p className="muted">{waiting ? '前置签署完成后恢复处理' : candidate ? '领取后由你负责处理' : delegated ? '受托处理中，请先归还原审批人' : '请核对单据后提交意见'}</p>
      </div>
      <div className="approval-task-controls">
        <div className="actions">
          <Link className="route-link" to={orderUrl(task.businessKey)}>查看采购单 ↗</Link>
          {!waiting && <input aria-label={`${task.title}处理意见`} placeholder={candidate || delegated ? '填写操作原因（必填）' : '审批意见；释放任务时必填'}
            maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} />}
        </div>
        {!waiting && <div className="actions">
          {candidate ? <button className="primary" disabled={busy || !reason.trim()} onClick={() => void manage('claim', '已领取，请在待我处理中继续')}>领取任务</button>
            : delegated ? <button disabled={busy || !reason.trim()} onClick={() => void manage('resolve', '已归还原审批人')}>归还审批人</button>
            : <>
              {task.assignment === 'candidate' && <button disabled={busy || !reason.trim()} onClick={() => void manage('unclaim', '已释放到候选池')}>释放任务</button>}
              <button disabled={busy} onClick={() => void run(() => client.decideApprovalTask(task.id, 'reject', { expectedRevision: task.revision, comment: reason }), '已驳回')}>驳回</button>
              <button disabled={busy} onClick={() => void run(() => client.decideApprovalTask(task.id, 'return', { expectedRevision: task.revision, comment: reason }), '已退回修改')}>退回修改</button>
              <button disabled={busy} className="primary" onClick={() => void run(() => client.decideApprovalTask(task.id, 'approve', { expectedRevision: task.revision, comment: reason }), '已通过审批')}>通过审批</button>
              {task.actions.transfer && <button disabled={busy} onClick={() => setOperation('transfer')}>转办</button>}
              {task.actions.delegate && <button disabled={busy} onClick={() => setOperation('delegate')}>委派</button>}
              {task.actions.addSign && task.taskKind === 'original' && task.signPositions.map(position => <button key={position} disabled={busy}
                onClick={() => setOperation(position)}>{position === 'before' ? '前加签' : position === 'after' ? '后加签' : '并行加签'}</button>)}
            </>}
        </div>}
      </div>
      {operation && <TaskOperationDialog task={task} operation={operation} close={() => setOperation(null)} />}
    </div>
  );
}

/**
 * 读取当前视图并区分加载、错误与空结果；URL 中未知 view 按默认待办读取，不制造无效请求。
 * @param orderUrl 由 app 将业务主键转为采购详情地址；组件只改变 view 参数，保留其他 URL 参数。
 * 人员操作使用业务协作名录，不读取完整组织用户；动作政策与签序来自实例快照，不按最新声明猜测在途权限。
 */
export function ApprovalTasksPage({ orderUrl }: { orderUrl: (id: string) => string }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('view');
  const view = selected === 'candidates' || selected === 'waiting' ? selected : 'pending';
  const tasks = useApprovalTasks(view);
  const { run, busy, message, clearMessage } = useCommand();
  return (
    <>
      <AssistantPage context={{ page: { id: 'approval-inbox', title: '审批待办', kind: 'list', route: '/approvals' },
        visibleContent: [{ id: 'visible-tasks', text: tasks.data ? `${views[view]}当前显示 ${tasks.data.length} 项，以重新查询为准。` : '审批任务正在读取或暂时不可用。' }],
      }} suggestions={['查看当前待我处理的审批', '通过、驳回和退回修改有什么区别？']} />
      <PageHeading eyebrow="APPROVAL INBOX" title="审批待办" description="领取、处理和跟进你的审批任务。" />
      {message && <Notice onClose={clearMessage}>{message}</Notice>}
      <section className="panel approval-inbox">
        <div className="section-head">
          <div className="actions" aria-label="审批任务视图">
            {Object.entries(views).map(([key, label]) => <button key={key} disabled={busy} aria-pressed={key === view} className={key === view ? 'primary' : ''}
              onClick={() => setParams(previous => { const next = new URLSearchParams(previous); if (key === 'pending') next.delete('view'); else next.set('view', key); return next; })}>{label}</button>)}
          </div>
          <button disabled={busy || tasks.isFetching} onClick={() => void tasks.refetch()}>刷新</button>
        </div>
        {tasks.isError && <p className="error">{tasks.error.message}</p>}
        {tasks.isPending && <p className="empty">正在读取任务…</p>}
        {tasks.data?.map(task => <TaskRow key={`${task.id}:${task.revision}`} task={task} orderUrl={orderUrl} busy={busy} run={run} />)}
        {tasks.data?.length === 0 && <div className="empty"><h3>当前没有{views[view]}的任务</h3><p>任务分配或签署顺序变化后，可刷新查看。</p></div>}
      </section>
    </>
  );
}
