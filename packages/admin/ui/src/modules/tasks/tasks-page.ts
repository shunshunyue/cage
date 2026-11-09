/**
 * 当前用户审批收件箱，合并本人、可领取和等待加签任务；管理动作与决定均通过宿主会话接口提交。
 * 待办分配只说明选人，最终动作仍受业务结论命令的能力、范围和硬约束；页面不直接改变单据状态。
 */
import { api, run, state } from '../../shared/api.js';
import { badge, emptyState, formatTime, h, panel, table } from '../../shared/dom.js';
import { objectName } from '../../shared/labels.js';
import { navigate } from '../../shared/navigation.js';
import { deadlineCell } from './operations-pages.js';

interface Task {
  id: string;
  process: string;
  title: string;
  /** 声明冻结的并行组/分支路径，帮助识别同一单据同时产生的不同责任。 */
  branchPath?: { parallel: string; branch: string }[];
  aggregate: string;
  businessKey: string;
  vars: Record<string, unknown>;
  createdAt: string;
  /** 节点总办理时限；未启用或旧轮次为 null，任务分配变更不会重新起算。 */
  dueAt: string | null;
  /** 服务端待办版本，决定时一并提交以拒绝转办后的旧页面操作。 */
  revision: number;
  /** pending 可操作，waiting 等待其他签署完成，只展示状态。 */
  status: string;
  /** 候选池在领取前无持有人，不能直接批准。 */
  assigneeId: string | null;
  /** candidate 当前持有人可填写原因后释放，实际条件由服务端核验。 */
  assignment: 'direct' | 'candidate';
  /** 未归还的委派只显示归还入口，不能提交审批结论。 */
  delegation: 'pending' | 'resolved' | null;
  /** 加签位置只说明持久依赖，不表示自动拥有审批权限。 */
  signPosition: 'parallel' | 'before' | 'after' | null;
}

/**
 * 加载本人待办与页面需要的对象资料，展示任务、步骤和可用操作。
 * 提交期间禁止重复动作，成功后刷新待办，失败保留可理解原因；空列表表示当前请求没有可见待办。
 */
export async function renderTasks(main: HTMLElement) {
  main.classList.add('approval-workspace');
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
  const lists = await Promise.all([
    api<Task[]>('GET', '/api/approval/tasks'), api<Task[]>('GET', '/api/approval/candidate-tasks'),
    api<Task[]>('GET', '/api/approval/tasks?status=waiting'),
  ]);
  const tasks = lists.flat();
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
      '审批收件箱',
      `待处理 ${lists[0].length} 项 · 可领取 ${lists[1].length} 项 · 等待加签 ${lists[2].length} 项`,
      table<Task>(
        [
          [
            '审批事项',
            (task) =>
              h(
                'div',
                { class: 'stack-cell' },
                h('strong', {}, task.title),
                task.branchPath?.length ? h('small', {}, task.branchPath.map(part => `${part.parallel} · ${part.branch}`).join(' / ')) : null,
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
          ['办理截止', task => deadlineCell(task.dueAt)],
          ['处理阶段', task => badge(task.status === 'waiting' ? '等待加签' : task.assigneeId === null ? '可领取' : task.delegation === 'pending' ? '受托处理中' :
            task.signPosition === 'before' ? '前签' : task.signPosition === 'after' ? '后签' : task.signPosition === 'parallel' ? '并行加签' : '待处理')],
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
              if (task.status === 'waiting') return h('small', {}, '前置签署完成后恢复处理');
              const comment = h('input', {
                placeholder: '审批意见；领取、释放或归还时必填',
                'aria-label': `${task.title}审批意见`,
                maxlength: 1000,
              });
              const actions = h('div', { class: 'row-actions' });
              const submit = async (action: string, button: HTMLButtonElement) => {
                const management = ['claim', 'unclaim', 'resolve'].includes(action);
                comment.setCustomValidity(management && !comment.value.trim() ? '请填写操作原因' : '');
                if (!comment.reportValidity()) return;
                // 一项待办的两个结论互斥，发送期间同时禁用，避免界面重复提交相反结论。
                for (const item of actions.querySelectorAll('button')) item.disabled = true;
                const result = await run(
                  () => api('POST', `/api/approval/tasks/${task.id}/${action}`, { ...(management ? { reason: comment.value } : { comment: comment.value }), expectedRevision: task.revision }),
                  ({ approve: '已通过审批', reject: '已驳回', claim: '已领取任务', unclaim: '已释放到候选池', resolve: '已归还原审批人' } as Record<string, string>)[action],
                  button,
                );
                if (result) navigate('tasks');
                else for (const item of actions.querySelectorAll('button')) item.disabled = false;
              };
              if (task.assigneeId === null || task.delegation === 'pending') {
                const action = task.assigneeId === null ? 'claim' : 'resolve';
                actions.append(h('button', { class: 'small primary', onclick: event => submit(action, event.currentTarget as HTMLButtonElement) },
                  action === 'claim' ? '领取任务' : '归还审批人'));
              } else {
                if (task.assignment === 'candidate') actions.append(h('button', { class: 'small', onclick: event => submit('unclaim', event.currentTarget as HTMLButtonElement) }, '释放任务'));
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
              }
              return h('div', { class: 'task-actions' }, comment, actions);
            },
          ],
        ],
        tasks,
      ),
    ),
  );
}
