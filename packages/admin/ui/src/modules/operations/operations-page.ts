/**
 * 异步运行运维页面，读取 outbox 汇总、未处理死信和注册任务状态。
 * 运维读取与管理能力分开，重放/丢弃与启停任务通过系统接口执行；界面不直接操作数据库。
 */
import { api, can, run } from '../../shared/api.js';
import { badge, field, formatTime, h, icon, modal, panel, table } from '../../shared/dom.js';
import { capabilityName, eventName, jobName, statusName } from '../../shared/labels.js';
import { navigate } from '../../shared/navigation.js';

interface Summary {
  outbox: { status: string; n: number; oldest: string | null }[];
  deadLetters: number;
}
interface DeadLetter {
  id: number;
  event: string;
  aggregate_id: string;
  attempts: number;
  error: string | null;
  created_at: string;
}
interface Job {
  name: string;
  description: string | null;
  cron: string;
  calls: string[];
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
}

/**
 * 并行取得运行快照并渲染统计、队列、死信和任务列表。
 * Sys.ops.manage 控制动作按钮，成功请求后重新加载数据；重放仅表示重新投递，不保证远端业务最终成功。
 */
export async function renderOperations(main: HTMLElement) {
  const [summary, dead, jobs] = await Promise.all([
    api<Summary>('GET', '/api/sys/ops/summary'),
    api<DeadLetter[]>('GET', '/api/sys/ops/dead-letters'),
    api<Job[]>('GET', '/api/sys/ops/jobs'),
  ]);
  const manageable = can('Sys.ops.manage');
  main.append(
    h(
      'div',
      { class: 'stats-row' },
      stat(
        '待投递事件',
        summary.outbox.reduce((sum, item) => sum + item.n, 0),
        'inbox',
      ),
      stat('待处理死信', summary.deadLetters, 'info', summary.deadLetters > 0),
      stat('运行中定时任务', jobs.filter((job) => job.enabled).length, 'clock'),
    ),
  );
  main.append(
    panel(
      '事件投递队列',
      '事件由后台 worker 按顺序投递，失败后自动退避重试。',
      table<Summary['outbox'][number]>(
        [
          [
            '处理状态',
            (item) => badge(statusName(item.status), item.status === 'pending' ? 'amber' : 'neutral'),
          ],
          ['事件数量', (item) => h('strong', {}, item.n)],
          ['最早进入时间', (item) => formatTime(item.oldest)],
        ],
        summary.outbox,
        '投递队列已清空，没有积压事件',
      ),
    ),
  );
  main.append(
    panel(
      '需要处理的死信',
      '请先排查失败原因再重放。同一单据的后续事件会等待这条事件处理完成。',
      table<DeadLetter>(
        [
          [
            '业务事件',
            (item) =>
              h(
                'div',
                { class: 'stack-cell' },
                h('strong', {}, eventName(item.event)),
                h('code', {}, item.event),
              ),
          ],
          ['关联单据', (item) => h('code', { title: item.aggregate_id }, item.aggregate_id.slice(0, 12))],
          ['尝试次数', (item) => badge(`${item.attempts} 次`, 'amber')],
          [
            '失败原因',
            (item) =>
              h(
                'details',
                {},
                h('summary', { class: 'failure-summary' }, (item.error || '无错误说明').slice(0, 65)),
                h('pre', {}, item.error || '无错误说明'),
              ),
          ],
          ['进入时间', (item) => formatTime(item.created_at)],
          [
            '处理',
            (item) =>
              manageable
                ? h(
                    'div',
                    { class: 'row-actions' },
                    h(
                      'button',
                      {
                        class: 'small primary',
                        onclick: async (event) => {
                          if (
                            await run(
                              () => api('POST', `/api/sys/ops/dead-letters/${item.id}/replay`),
                              '事件已重新进入投递队列',
                              event.currentTarget as HTMLButtonElement,
                            )
                          )
                            navigate('ops');
                        },
                      },
                      '重新投递',
                    ),
                    h('button', { class: 'small danger', onclick: () => discard(item) }, '丢弃'),
                  )
                : h('span', { class: 'muted' }, '仅查看'),
          ],
        ],
        dead,
        '当前没有待处理的死信',
      ),
    ),
  );
  main.append(
    panel(
      '定时任务',
      '按业务声明的时间执行；停用后不会继续触发新的调度。',
      table<Job>(
        [
          [
            '任务名称',
            (job) =>
              h('div', { class: 'stack-cell' }, h('strong', {}, jobName(job.name)), h('code', {}, job.name)),
          ],
          ['执行计划', (job) => h('code', {}, job.cron)],
          [
            '业务操作',
            (job) =>
              h(
                'div',
                { class: 'tag-list' },
                job.calls.map((name) => badge(capabilityName(name))),
              ),
          ],
          [
            '上次运行',
            (job) =>
              h(
                'div',
                { class: 'stack-cell' },
                formatTime(job.lastRunAt),
                job.lastStatus &&
                  badge(statusName(job.lastStatus), job.lastStatus === 'ok' ? 'green' : 'amber'),
              ),
          ],
          [
            '下次计划',
            (job) => (job.enabled ? formatTime(job.nextRunAt) : h('span', { class: 'muted' }, '已暂停调度')),
          ],
          [
            '状态与操作',
            (job) =>
              h(
                'div',
                { class: 'row-actions' },
                badge(job.enabled ? '运行中' : '已停用', job.enabled ? 'green' : 'neutral'),
                manageable &&
                  h(
                    'button',
                    {
                      class: 'small',
                      onclick: async (event) => {
                        if (
                          await run(
                            () =>
                              api(
                                'POST',
                                `/api/sys/ops/jobs/${encodeURIComponent(job.name)}/${job.enabled ? 'disable' : 'enable'}`,
                              ),
                            '定时任务状态已更新',
                            event.currentTarget as HTMLButtonElement,
                          )
                        )
                          navigate('ops');
                      },
                    },
                    job.enabled ? '停用' : '启用',
                  ),
              ),
          ],
        ],
        jobs,
        '当前业务没有声明定时任务',
      ),
    ),
  );

  /**
   * 打开针对单条死信的确认操作，提交 discard 后按成功结果刷新页面。
   * 丢弃会改变后续事件处理条件，因此需要用户明确选择，不能作为自动修复失败的默认动作。
   */
  function discard(item: DeadLetter) {
    const confirm = h('input', { type: 'checkbox', required: true });
    const save = h('button', { class: 'danger', type: 'submit' }, '确认丢弃事件');
    const form = h(
      'form',
      {
        class: 'stack-form',
        onsubmit: async (event) => {
          event.preventDefault();
          if (
            await run(() => api('POST', `/api/sys/ops/dead-letters/${item.id}/discard`), '事件已丢弃', save)
          ) {
            dialog.close();
            navigate('ops');
          }
        },
      },
      h('p', {}, '丢弃后，这条事件将不再重试。请确认业务补偿或人工处理已经完成。'),
      field('我已了解此操作会停止该事件的后续处理', confirm),
      h('div', { class: 'form-actions' }, save),
    );
    const dialog = modal('丢弃死信事件', form);
  }
}
/**
 * 以既有计数生成运行统计卡，warning 仅决定视觉提示，不改变后台任务状态。
 */
function stat(label: string, value: number, glyph: string, warning = false) {
  return h(
    'div',
    { class: `stat-card ${warning ? 'attention' : ''}` },
    h('span', { class: 'stat-icon' }, icon(glyph)),
    h('div', {}, h('span', {}, label), h('strong', {}, value)),
  );
}
