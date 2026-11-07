// 审批待办独立成页；结论调用框架审批接口，领域约束仍在后端执行。
import { client } from '@app/contracts';
import { Link } from 'react-router-dom';
import { useCommand } from '../../../shared/hooks/use-command';
import { Notice } from '../../../shared/ui/notice';
import { PageHeading } from '../../../shared/ui/page-heading';
import { useApprovalTasks } from '../hooks/use-approval-tasks';
import { AssistantPage } from '../../../shared/ui/assistant-scope';

export function ApprovalTasksPage({ orderUrl }: { orderUrl: (id: string) => string }) {
  const tasks = useApprovalTasks();
  const { run, busy, message, clearMessage } = useCommand();
  return (
    <>
      <AssistantPage context={{ page: { id: 'approval-inbox', title: '审批待办', kind: 'list', route: '/approvals' },
        visibleContent: [{ id: 'pending-tasks', text: tasks.data ? `当前待处理审批 ${tasks.data.length} 项，以重新查询的待办为准。` : '审批待办正在读取或暂时不可用。' }],
      }} suggestions={['查看当前待我处理的审批', '通过、驳回和退回修改有什么区别？']} />
      <PageHeading eyebrow="APPROVAL INBOX" title="审批待办" description="处理分配给你的审批任务。" />
      {message && <Notice onClose={clearMessage}>{message}</Notice>}
      <section className="panel">
        <div className="section-head">
          <h2>待你处理</h2>
          <button onClick={() => void tasks.refetch()}>刷新</button>
        </div>
        {tasks.isError && <p className="error">{tasks.error.message}</p>}
        {tasks.isPending && <p className="empty">正在读取待办…</p>}
        {tasks.data?.map((task) => (
          <div className="task" key={task.id}>
            <div>
              <h3>{task.title}</h3>
              <p className="mono muted">PO-{task.businessKey.slice(0, 8).toUpperCase()}</p>
            </div>
            <div className="actions">
              {/* 单据的页面地址由 app 组合层提供，审批模块不依赖采购页面内部文件。 */}
              <Link className="route-link" to={orderUrl(task.businessKey)}>
                查看采购单 ↗
              </Link>
              <button
                disabled={busy}
                onClick={() => run(() => client.post(`/api/approval/tasks/${task.id}/reject`), '已驳回')}
              >
                驳回
              </button>
              <button disabled={busy} onClick={() => run(() => client.post(`/api/approval/tasks/${task.id}/return`), '已退回修改')}>退回修改</button>
              <button
                disabled={busy}
                className="primary"
                onClick={() => run(() => client.post(`/api/approval/tasks/${task.id}/approve`), '已通过审批')}
              >
                通过审批
              </button>
            </div>
          </div>
        ))}
        {tasks.data?.length === 0 && (
          <div className="empty">
            <h3>待办已清空</h3>
            <p>新任务分配给你后会显示在这里。</p>
          </div>
        )}
      </section>
    </>
  );
}
