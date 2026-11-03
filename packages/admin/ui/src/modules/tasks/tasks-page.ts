import { api, run, state } from '../../shared/api.js';
import { badge, emptyState, formatTime, h, panel, table } from '../../shared/dom.js';
import { objectName } from '../../shared/labels.js';
import { navigate } from '../../shared/navigation.js';

interface Task {
  id: string;
  process: string;
  title: string;
  aggregate: string;
  businessKey: string;
  vars: Record<string, unknown>;
  createdAt: string;
}

export async function renderTasks(main: HTMLElement) {
  const hasApprovals = state.catalog!.approvals.length > 0;
  if (!hasApprovals) {
    main.append(
      panel(
        '我的审批待办',
        undefined,
        emptyState('当前没有启用审批流程', '业务启用审批后，分配给你的任务会显示在这里。'),
      ),
    );
    return;
  }
  const tasks = await api<Task[]>('GET', '/api/approval/tasks');
  if (!tasks.length) {
    main.append(
      panel(
        '我的审批待办',
        undefined,
        emptyState('待办已处理完毕', '新的审批任务分配给你后，会显示在这里。'),
      ),
    );
    return;
  }
  main.append(
    panel(
      '等待你处理',
      `共 ${tasks.length} 项待办。审批结论会继续执行业务权限与规则校验。`,
      table<Task>(
        [
          [
            '审批事项',
            (task) =>
              h(
                'div',
                { class: 'stack-cell' },
                h('strong', {}, task.title),
                h(
                  'small',
                  {},
                  state.catalog!.approvals.find((item) => item.process === task.process)?.label || '业务审批',
                ),
              ),
          ],
          [
            '关联单据',
            (task) =>
              h(
                'div',
                { class: 'stack-cell' },
                badge(objectName(task.aggregate)),
                h('code', {}, task.businessKey.slice(0, 8)),
              ),
          ],
          ['提交时间', (task) => formatTime(task.createdAt)],
          [
            '流程信息',
            (task) =>
              h(
                'details',
                {},
                h('summary', {}, '查看详情'),
                h('pre', {}, JSON.stringify(task.vars, null, 2)),
              ),
          ],
          [
            '处理意见与操作',
            (task) => {
              const comment = h('input', {
                placeholder: '填写审批意见（可选）',
                'aria-label': `${task.title}审批意见`,
              });
              const actions = h('div', { class: 'row-actions' });
              const submit = async (action: string, button: HTMLButtonElement) => {
                // 一项待办的两个结论互斥，发送期间同时禁用，避免界面重复提交相反结论。
                for (const item of actions.querySelectorAll('button')) item.disabled = true;
                const result = await run(
                  () => api('POST', `/api/approval/tasks/${task.id}/${action}`, { comment: comment.value }),
                  action === 'approve' ? '已通过审批' : '已驳回',
                  button,
                );
                if (result) navigate('tasks');
                else for (const item of actions.querySelectorAll('button')) item.disabled = false;
              };
              actions.append(
                h(
                  'button',
                  {
                    class: 'small',
                    onclick: (event) => submit('reject', event.currentTarget as HTMLButtonElement),
                  },
                  '驳回',
                ),
                h(
                  'button',
                  {
                    class: 'small primary',
                    onclick: (event) => submit('approve', event.currentTarget as HTMLButtonElement),
                  },
                  '通过审批',
                ),
              );
              return h('div', { class: 'task-actions' }, comment, actions);
            },
          ],
        ],
        tasks,
      ),
    ),
  );
}
