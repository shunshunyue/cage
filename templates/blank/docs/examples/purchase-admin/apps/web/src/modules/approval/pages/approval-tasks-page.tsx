// 审批待办独立成页；结论调用框架审批接口，领域约束仍在后端执行。
import { client } from '@app/contracts';
import { Link } from 'react-router-dom';
import { useCommand } from '../../../shared/hooks/use-command';
import { Notice } from '../../../shared/ui/notice';
import { PageHeading } from '../../../shared/ui/page-heading';
import { useApprovalTasks } from '../hooks/use-approval-tasks';

export function ApprovalTasksPage({ orderUrl }: { orderUrl: (id: string) => string }) {
  const tasks = useApprovalTasks();
  const { run, busy, message, clearMessage } = useCommand();
  return (
    <>
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
