/**
 * 操作审计查询页面，通过安全审计接口读取记录并展示操作人、时间和变化详情。
 * 筛选、分页与详情均属于读操作；界面不补写审计，也不将查到的部分记录当作完整请求轨迹。
 */
import { api, run, state } from '../../shared/api.js';
import { badge, field, formatTime, h, panel, table } from '../../shared/dom.js';
import { capabilityName, objectName } from '../../shared/labels.js';

interface Audit {
  at: string;
  kind: string;
  actor_kind: string;
  actor: string;
  on_behalf_of: string | null;
  command: string | null;
  capability: string | null;
  aggregate: string | null;
  aggregate_id: string | null;
  result: string;
  diff: unknown;
  source: string;
}
const kinds: Record<string, string> = {
  write: '业务写入',
  read: '数据读取',
  denied: '拒绝访问',
  ops: '运维操作',
};
const actors: Record<string, string> = {
  user: '用户',
  process: '审批流程',
  external: '外部系统',
  job: '定时任务',
  system: '系统',
};

/**
 * 构建审计筛选器与列表，等待初次 load 完成；服务端仍校验 Sys.audit.read 与安全视图。
 * 详情通过 DOM 文本展示，包含结构化差异时也不解释为 HTML。
 */
export async function renderAudit(main: HTMLElement) {
  const actor = h('input', { placeholder: '操作人的用户 ID' });
  const aggregate = h(
    'select',
    {},
    h('option', { value: '' }, '全部业务对象'),
    state.catalog!.aggregates.map((item) => h('option', { value: item.name }, item.label)),
  );
  const aggregateId = h('input', { placeholder: '完整单据 ID' });
  const command = h('input', { placeholder: '例如 PurchaseOrder.approve' });
  const kind = h(
    'select',
    {},
    h('option', { value: '' }, '全部操作类型'),
    Object.entries(kinds).map(([value, label]) => h('option', { value }, label)),
  );
  const fields = { actor, aggregate, aggregateId, command, kind };
  const out = h('div');
  const search = h('button', { type: 'submit', class: 'primary' }, '查询记录');
  const previous = h(
    'button',
    {
      class: 'small',
      onclick: () => {
        page--;
        void load();
      },
    },
    '上一页',
  );
  const next = h(
    'button',
    {
      class: 'small',
      onclick: () => {
        page++;
        void load();
      },
    },
    '下一页',
  );
  const pageText = h('span', { class: 'muted' });
  let page = 1;
  main.append(
    panel(
      '审计记录',
      '查询谁在什么时间操作了哪些数据，以及操作是否成功。',
      h(
        'form',
        {
          class: 'audit-filters',
          onsubmit: (event) => {
            event.preventDefault();
            page = 1;
            void load();
          },
        },
        field('业务对象', aggregate),
        field('操作类型', kind),
        field('操作人', actor),
        field('单据编号', aggregateId),
        field('操作标识', command),
        search,
      ),
      out,
      h('div', { class: 'pagination' }, pageText, h('div', { class: 'row-actions' }, previous, next)),
    ),
  );
  /**
   * 按当前筛选和页码请求审计记录，更新表格及分页控制。
   * 查询失败保留明确错误反馈，不生成占位成功记录；请求只读，不重放任何业务命令。
   */
  async function load() {
    const params = new URLSearchParams(
      Object.entries(fields)
        .filter(([, input]) => input.value)
        .map(([key, input]) => [key, input.value]),
    );
    params.set('page', String(page));
    params.set('pageSize', '50');
    const result = await run(
      () => api<{ items: Audit[] }>('GET', `/api/sys/audit?${params}`),
      undefined,
      search,
    );
    if (!result) return;
    out.replaceChildren(
      table<Audit>(
        [
          ['发生时间', (item) => formatTime(item.at)],
          [
            '操作类型',
            (item) => badge(kinds[item.kind] || '系统记录', item.kind === 'denied' ? 'red' : 'neutral'),
          ],
          [
            '操作主体',
            (item) =>
              h(
                'div',
                { class: 'stack-cell' },
                h('strong', {}, actors[item.actor_kind] || '系统主体'),
                h('code', { title: item.actor }, item.actor.slice(0, 12)),
                item.on_behalf_of && h('small', {}, `代表用户 ${item.on_behalf_of.slice(0, 8)}`),
              ),
          ],
          [
            '执行操作',
            (item) =>
              h(
                'div',
                { class: 'stack-cell' },
                h('strong', {}, capabilityName(item.command || item.capability || '')),
                h('code', {}, item.command || item.capability || item.source),
              ),
          ],
          [
            '关联对象',
            (item) =>
              item.aggregate
                ? h(
                    'div',
                    { class: 'stack-cell' },
                    h('span', {}, objectName(item.aggregate)),
                    h('code', { title: item.aggregate_id }, item.aggregate_id?.slice(0, 12) || '—'),
                  )
                : '—',
          ],
          [
            '结果',
            (item) => badge(item.result === 'ok' ? '成功' : '未成功', item.result === 'ok' ? 'green' : 'red'),
          ],
          [
            '变更详情',
            (item) =>
              item.diff
                ? h(
                    'details',
                    {},
                    h('summary', {}, '查看变更'),
                    h('pre', {}, JSON.stringify(item.diff, null, 2)),
                  )
                : h('span', { class: 'muted' }, '无字段变更'),
          ],
        ],
        result.items,
      ),
    );
    pageText.textContent = `第 ${page} 页 · 本页 ${result.items.length} 条，每页最多 50 条`;
    previous.disabled = page === 1;
    next.disabled = result.items.length < 50;
  }
  await load();
}
