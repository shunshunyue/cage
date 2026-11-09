/**
 * 框架自带的申请催办和站内提醒页面，任何启用审批运营的应用都可从 /admin 直接使用。
 * 页面仅消费通用审批 HTTP 协议，不依赖业务领域、采购字段或数据库；状态以服务端返回为准。
 * 过滤保存在 hash 查询参数，写操作完成后刷新当前页；纯文本 DOM 渲染避免把催办原因解释成 HTML。
 */
import { api, run, state, toast } from '../../shared/api.js';
import { badge, emptyState, formatTime, h, panel, table } from '../../shared/dom.js';
import { objectName } from '../../shared/labels.js';
import { navigate } from '../../shared/navigation.js';

/** 通用申请摘要；currentStep 为零基索引，两个时间均为 UTC，null 分别表示无时限或尚未催办。 */
interface RequestItem {
  /** 运行实例、流程、业务对象与当前步骤的展示字段。 */
  id: string; process: string; aggregate: string; businessKey: string; currentStep: number; title: string;
  /** 并行催办传递完整集合，展示每条分支独立进度；旧服务端无此字段时仍按单节点显示。 */
  currentSteps?: number[];
  activeSteps?: { step: number; title: string; dueAt: string | null; branchPath: { parallel: string; branch: string }[] }[];
  /** 节点总办理时限以及持久冷却截止，不根据浏览器时钟给服务端授权。 */
  dueAt: string | null; nextUrgeAt: string | null;
}

/** 本人当前仍有权查看的提醒；原因来自申请人输入，只作为文本显示。 */
interface NoticeItem {
  /** 记录游标、对象定位和步骤标题；不暴露完整流程变量。 */
  id: string; aggregate: string; businessKey: string; process: string; title: string;
  /** 临期、超时或手动催办；readAt 为空表示未读。 */
  kind: 'due_soon' | 'overdue' | 'urge'; reason: string | null; createdAt: string; readAt: string | null; dueAt: string | null;
}

/** 显示节点总截止时间和浏览器当前时刻的提示；后端会独立判定，不把显示时差作为决定条件。 */
export function deadlineCell(dueAt: string | null | undefined): HTMLElement {
  if (!dueAt) return h('small', {}, '未设时限');
  const late = Date.parse(dueAt) <= Date.now();
  return h('div', { class: 'stack-cell' }, badge(late ? '已超时' : '办理中', late ? 'red' : 'neutral'),
    h('small', {}, formatTime(dueAt)));
}

/** 目录显式声明未启用时提供说明并停止加载，不将不存在的接口报错伪装为无提醒。 */
function enabled(main: HTMLElement): boolean {
  if (state.catalog?.approvalOperations) return true;
  main.append(panel('流程协作', undefined, emptyState('当前应用未启用流程提醒', '启用后可在此查看站内提醒及本人申请。')));
  return false;
}

/** 使用聚合中文名与完整单据标识，跨业务通用；不猜测应用自定义的详情 URL。 */
function subject(item: { aggregate: string; businessKey: string }): HTMLElement {
  return h('div', { class: 'stack-cell' }, badge(objectName(item.aggregate)), h('code', { title: item.businessKey }, item.businessKey));
}

/** 刷新只重读当前页面；没有后台定时器，离开页面后不会遗留轮询或自动重放催办。 */
function refresh(page: string): HTMLButtonElement {
  return h('button', { class: 'small', onclick: () => navigate(page) }, '刷新');
}

/**
 * 展示本人运行中的可催办申请。提交绑定实例 UUID 和当前步骤，原因必填，防止旧页面催办新轮次。
 * 冷却期间明确给出下次时间；按钮只是提示，后端仍锁定复核。成功后显示真实接收人数并重新读取。
 */
export async function renderApprovalRequests(main: HTMLElement): Promise<void> {
  main.classList.add('approval-workspace');
  if (!enabled(main)) return;
  const items = await api<RequestItem[]>('GET', '/api/approval/requests');
  main.append(panel('我的申请', '查看正在审批的申请，向当前办理人发送站内催办。节点时限包含领取、委派和加签所用时间。',
    h('div', { class: 'table-toolbar' }, h('span', {}, `当前显示 ${items.length} 项`), refresh('requests')),
    table<RequestItem>([
      ['申请事项', item => subject(item)],
      ['当前环节', item => h('div', { class: 'stack-cell' }, ...(item.activeSteps?.map(node => h('div', { class: 'stack-cell' },
        h('strong', {}, node.title), h('small', {}, node.branchPath.map(part => `${part.parallel} · ${part.branch}`).join(' / ') || '主线审批')))
        ?? [h('strong', {}, item.title)]))],
      ['最近截止', item => deadlineCell(item.dueAt)],
      ['催办', item => {
        const cooling = !!item.nextUrgeAt && Date.parse(item.nextUrgeAt) > Date.now();
        const reason = h('input', { 'aria-label': `${item.title}催办原因`, placeholder: '请说明需要加快处理的原因', maxlength: 1000, required: true });
        const button = h('button', { class: 'small primary', disabled: cooling, onclick: async event => {
          reason.setCustomValidity(reason.value.trim() ? '' : '请填写催办原因');
          if (!reason.reportValidity()) return;
          const result = await run(() => api<{ recipientCount: number; nextUrgeAt: string }>('POST',
            `/api/approval/instances/${item.id}/urge`, { expectedStep: item.currentStep, ...(item.currentSteps ? { expectedSteps: item.currentSteps } : {}), reason: reason.value.trim() }), undefined, event.currentTarget as HTMLButtonElement);
          if (result) { toast(`已发送 ${result.recipientCount} 条站内催办提醒`); navigate('requests'); }
        } }, cooling ? '冷却中' : '发送催办');
        return h('div', { class: 'task-actions' }, reason, h('div', { class: 'row-actions' }, button),
          item.nextUrgeAt ? h('small', {}, `可再次催办：${formatTime(item.nextUrgeAt)}${cooling ? '，到时请刷新' : ''}`) : null);
      }],
    ], items, '当前没有可催办的运行申请')));
}

/**
 * 分页展示当前仍与本人有关的流程提醒；URL view=unread 固定筛选，可深链接和浏览器前进后退。
 * 已读写入成功才刷新；翻页沿服务端游标，即使权限过滤形成空页也保留“继续加载”。
 * 列表读取不自动标已读，离开页面后忽略正在返回的追加页，避免旧页更新当前画面。
 */
export async function renderApprovalNotices(main: HTMLElement): Promise<void> {
  main.classList.add('approval-workspace');
  if (!enabled(main)) return;
  const unread = new URLSearchParams(location.hash.split('?')[1] ?? '').get('view') === 'unread';
  const page = `notices?view=${unread ? 'unread' : 'all'}`;
  const query = `/api/approval/notices?limit=50&unreadOnly=${unread}`;
  type NoticePage = { items: NoticeItem[]; nextCursor: string | null };
  const initial = await api<NoticePage>('GET', query);
  const rows = [...initial.items];
  let next = initial.nextCursor;
  const content = h('div');
  const more = h('button', { class: 'small', onclick: async event => {
    if (!next) return;
    const result = await run(() => api<NoticePage>('GET', `${query}&after=${encodeURIComponent(next!)}`), undefined, event.currentTarget as HTMLButtonElement);
    if (!result || !content.isConnected) return;
    rows.push(...result.items); next = result.nextCursor; draw();
  } }, '继续加载');
  /** 仅由已完成的读请求重建表格；按钮内容与已读时间始终来自持久状态。 */
  function draw(): void {
    content.replaceChildren(table<NoticeItem>([
      ['提醒事项', item => h('div', { class: 'stack-cell' }, badge(
        item.kind === 'overdue' ? '已超时' : item.kind === 'due_soon' ? '即将到期' : '申请人催办', item.kind === 'overdue' ? 'red' : 'amber'),
        h('strong', {}, item.title), item.reason ? h('span', {}, item.reason) : h('small', {}, '请及时查看并处理当前审批任务'))],
      ['关联单据', item => subject(item)],
      ['节点截止', item => item.dueAt ? formatTime(item.dueAt) : '未设时限'],
      ['提醒时间', item => formatTime(item.createdAt)],
      ['阅读状态', item => item.readAt ? h('div', { class: 'stack-cell' }, badge('已读', 'green'), h('small', {}, formatTime(item.readAt))) :
        h('button', { class: 'small', onclick: async event => {
          const result = await run(() => api('POST', `/api/approval/notices/${item.id}/read`), '已标记为已读', event.currentTarget as HTMLButtonElement);
          if (result) navigate(page);
        } }, '标记已读')],
    ], rows, unread ? '当前没有可见的未读提醒' : '当前没有可见的流程提醒'));
    more.hidden = !next;
  }
  draw();
  main.append(panel('流程提醒', '临期、超时与申请人催办集中在这里。提醒只提示办理，不会自动作出审批决定。',
    h('div', { class: 'table-toolbar' }, h('div', { class: 'row-actions' },
      h('a', { class: `approval-filter ${unread ? 'selected' : ''}`, href: '#/notices?view=unread', 'aria-current': unread ? 'page' : undefined }, '未读'),
      h('a', { class: `approval-filter ${!unread ? 'selected' : ''}`, href: '#/notices?view=all', 'aria-current': !unread ? 'page' : undefined }, '全部'),
      h('a', { class: 'approval-filter', href: '#/tasks' }, '前往待办')), refresh(page)), content, more));
}
