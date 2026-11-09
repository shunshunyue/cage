/**
 * 第三方同步记录查询页面，以连接器和状态筛选展示实际外呼记录。
 * 响应受服务器数量上限限制，结果记录与业务最终完成是不同事实，页面没有绕过未知结果隔离的重发入口。
 */
import { api, run, state } from '../../shared/api.js';
import { badge, field, formatTime, h, panel, table } from '../../shared/dom.js';

interface SyncRecord {
  connector: string;
  operation: string;
  ref_id: string | null;
  status: string;
  http_status: number | null;
  attempts: number;
  error: string | null;
  updated_at: string;
}

/**
 * 构建连接器/状态筛选与同步表格，初始 load 完成后返回。
 * 读取需运维权限，错误和 HTTP 状态用于定位外部调用，不把 fake 或单次回执当真实系统验收。
 */
export async function renderSync(main: HTMLElement) {
  const connector = h('input', { placeholder: '连接器标识，留空查看全部' });
  const status = h(
    'select',
    {},
    h('option', { value: '' }, '全部结果'),
    h('option', { value: 'ok' }, '同步成功'),
    h('option', { value: 'failed' }, '同步失败'),
  );
  const query = h('button', { class: 'primary', type: 'submit' }, '查询记录');
  const out = h('div');
  main.append(
    panel(
      '外部系统同步记录',
      '查看出站请求的结果、重试次数与失败原因，辅助第三方联调与排障。',
      h(
        'form',
        {
          class: 'sync-filters',
          onsubmit: (event) => {
            event.preventDefault();
            void load();
          },
        },
        field('连接器', connector),
        field('同步结果', status),
        query,
      ),
      out,
    ),
  );
  /**
   * 根据当前连接器及状态筛选发起只读请求，再替换同步记录列表。
   * 查询失败通过页面反馈，不修改失败计数、回执或任务状态。
   */
  async function load() {
    const params = new URLSearchParams();
    if (connector.value) params.set('connector', connector.value);
    if (status.value) params.set('status', status.value);
    const result = await run(
      () => api<SyncRecord[]>('GET', `/api/sys/ops/sync-records?${params}`),
      undefined,
      query,
    );
    if (!result) return;
    out.replaceChildren(
      table<SyncRecord>(
        [
          [
            '连接器 / 操作',
            (item) =>
              h(
                'div',
                { class: 'stack-cell' },
                h(
                  'strong',
                  {},
                  state.catalog!.labels[`connector:connector:${item.connector}`] ||
                    state.catalog!.labels[`connector:${item.connector}`] ||
                    '外部系统连接器',
                ),
                h('code', {}, `${item.connector}.${item.operation}`),
              ),
          ],
          ['业务单据', (item) => h('code', {}, item.ref_id || '—')],
          [
            '同步结果',
            (item) =>
              badge(item.status === 'ok' ? '同步成功' : '同步失败', item.status === 'ok' ? 'green' : 'red'),
          ],
          ['响应状态', (item) => item.http_status ?? '未收到响应'],
          ['尝试次数', (item) => `${item.attempts} 次`],
          [
            '错误详情',
            (item) =>
              item.error
                ? h('details', {}, h('summary', {}, '查看原因'), h('pre', {}, item.error))
                : h('span', { class: 'muted' }, '—'),
          ],
          ['最近更新', (item) => formatTime(item.updated_at)],
        ],
        result,
        '暂无符合条件的同步记录',
      ),
    );
  }
  await load();
}
