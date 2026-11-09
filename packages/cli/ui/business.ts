/**
 * 业务地图页面渲染器，由 app 根据 URL 的板块、流程、步骤及页签调用。
 * 依次组织板块入口、流程图、说明与按需源码预览，并在同一流程内保存视野和手动布局。
 * 所有数据来自抽取快照；图谱不调度业务，离开视图需释放监听器，复制源码/上下文只写系统剪贴板。
 */
import type { GraphSnapshot, GraphSource } from '../src/graph-snapshot.js';
import { type GraphModel, type ViewNode } from '../src/graph-model.js';
import { approvalFlowForStep, type ApprovalGroup } from '../src/graph-approvals.js';
import {
  businessBlocks,
  businessOwner,
  businessStateSummary,
  businessConstraintLabel,
  traceBusinessFlow,
  flattenBusinessSteps,
  businessLabel,
  businessJourneys,
  traceBusinessProcess,
  traceBusinessLifecycle,
} from '../src/graph-business.js';
import {
  createFlowChart,
  createFlowChartState,
  type FlowChartState,
  type FlowDirection,
} from './flowchart.js';

const chartViews = new WeakMap<HTMLElement, { dispose: () => void }>();
const chartScenes = new WeakMap<
  HTMLElement,
  { scene: string; direction: FlowDirection; view: FlowChartState }
>();

/** 离开业务视图时释放画布监听器，保留同一流程的手动布局和视野。 */
/**
 * 释放当前 host 的画布监听器并移除活动实例，保留场景缓存供同流程再次进入。
 * @param host 业务视图容器。
 */
export function disposeBusiness(host: HTMLElement) {
  chartViews.get(host)?.dispose();
  chartViews.delete(host);
}

/**
 * 业务视图 URL 参数补丁；字符串写入参数，null 清除参数，便于同一导航处理器组合。
 */
type Navigation = Record<string, string | null>;
/**
 * 由 app 提供的导航与技术视图入口；showSystem 仅控制展示，不改变服务器权限。
 */
interface Actions {
  /** 是否将系统组织板块加入当前业务导航。 */
  showSystem: boolean;
  /** 合并 URL 参数并触发页面渲染；null 表示删除对应参数。 */
  navigate: (patch: Navigation) => void;
  /** 将指定节点切换到结构图或完整图解释入口。 */
  inspect: (key: string, view: 'structure' | 'all') => void;
}
/**
 * 创建 HTML 元素并用 textContent 填充文案，源码与业务标题都不能注入 HTML。
 */
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
/**
 * 建立仅在当前页面执行回调的按钮；需要可复制地址或新标签行为的导航使用 link。
 */
const action = (text: string, run: () => void, className = 'button secondary') => {
  const button = h('button', className, text);
  button.onclick = run;
  return button;
};
/**
 * 从当前 URL 合并导航参数并返回可用于真实链接的路径，null 删除参数，支持新标签打开。
 */
function route(patch: Navigation) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(patch))
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  return url.pathname + url.search;
}

/** 源码来自本次抽取保存的声明，不将任意路径发送给服务，也不执行预览内容。 */
/**
 * 创建只读声明代码预览，首次展开才请求当前快照中的已注册节点。
 * @param key 完整节点 key，不接受任意文件路径。
 * @param open 默认展开并在微任务开始加载。
 * @returns details 元素；错误展示重试，DOM 已卸载时忽略返回，复制仅写剪贴板。
 */
export function sourcePreview(key: string, open = true): HTMLElement {
  const details = h('details', 'source-preview');
  details.open = open;
  details.append(h('summary', '', '实现代码 · 只读'));
  const body = h('div', 'source-body');
  details.append(body);
  let requested = false;
  /**
   * 首次展开后加载一次已索引声明；进行中的请求不重复发送，失败后由重试按钮重置 requested。
   * DOM 卸载只忽略迟到结果，当前实现不主动取消网络请求。
   */
  const load = async () => {
    if (requested) return;
    requested = true;
    body.append(h('p', 'source-note', '正在读取声明…'));
    try {
      const response = await fetch(`/api/source?node=${encodeURIComponent(key)}`);
      const data = (await response.json()) as GraphSource & {
        error?: string;
        precision: string;
        extractedAt: string;
      };
      if (!response.ok) throw new Error(data.error);
      if (!body.isConnected) return;
      body.replaceChildren();
      const tools = h('div', 'source-tools');
      tools.append(h('span', '', `${data.file}:${data.line} · ${data.exportName}`));
      tools.append(
        action(
          '复制代码',
          async () => {
            try {
              await navigator.clipboard.writeText(data.code);
              tools.lastElementChild!.textContent = '已复制';
            } catch (error) {
              tools.append(h('span', 'source-error', `复制失败：${(error as Error).message}`));
            }
          },
          'text-button',
        ),
      );
      body.append(tools);
      if (data.precision === 'aggregate')
        body.append(h('p', 'source-note', '以下是所属业务对象的声明，当前没有该成员的独立源码位置。'));
      const pre = h('pre', 'source-code');
      const code = h('code');
      data.code.split('\n').forEach((line, index) => {
        const row = h('span', 'source-line', line || ' ');
        row.dataset.line = String(data.line + index);
        code.append(row);
      });
      pre.append(code);
      body.append(
        pre,
        h(
          'p',
          'source-note',
          `抽取时的实现 · ${new Date(data.extractedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 修改源码后请重新抽取`,
        ),
      );
    } catch (error) {
      if (!body.isConnected) return;
      body.replaceChildren(h('p', 'source-error', (error as Error).message));
      body.append(
        action(
          '重试',
          () => {
            requested = false;
            void load();
          },
          'text-button',
        ),
      );
    }
  };
  details.addEventListener('toggle', () => {
    if (details.open) void load();
  });
  if (open) queueMicrotask(() => void load());
  return details;
}

const typeName: Record<string, string> = {
  command: '业务操作',
  query: '业务查询',
  job: '定时处理',
  inbound: '外部通知',
  approval: '审批',
  outbound: '外部同步',
  event: '业务结果',
  reaction: '自动处理',
  route: '审批规则',
  stage: '流程说明',
  process: '业务流程',
  aggregate: '业务对象',
  state: '状态说明',
  entry: '新建入口',
};

/** 板块与流程入口逐层导航，因果步骤使用可交互流程图，说明与代码按需展开。
 * 地址保存板块、流程、步骤和代码页签，刷新、复制与前进后退使用同一入口。 */
/**
 * 按地址构建板块、流程列表或流程详情，替换旧 DOM 前释放旧画布。
 * @param host 页面容器，由 app 持有。
 * @param model 语义投影。
 * @param snapshot 标签及源码快照来源。
 * @param actions 导航、系统展示和技术详情回调。
 * 同场景保留滚动/焦点/手动布局；不执行业务命令，失效 URL 明确提示并回到现有入口。
 */
export function renderBusiness(
  host: HTMLElement,
  model: GraphModel,
  snapshot: GraphSnapshot,
  actions: Actions,
) {
  disposeBusiness(host);
  const params = new URLSearchParams(location.search);
  const blockId = params.get('block');
  const flowKey = params.get('flow');
  const scene = `${blockId ?? ''}/${flowKey ?? ''}`;
  const focusKey = host.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)?.dataset.businessFocus
    : undefined;
  const sameScene = host.dataset.scene === scene;
  const scroll = sameScene ? host.scrollTop : 0;
  host.dataset.scene = scene;
  host.replaceChildren();
  const labels = snapshot.presentation.labels;
  const name = (node: ViewNode) => businessLabel(node, labels);
  const blocks = businessBlocks(model, labels, actions.showSystem);
  /**
   * 创建真实 href 保留新标签和修饰键行为，普通主键点击才交给应用更新 URL。
   */
  const link = (text: string, patch: Navigation, className = 'business-link') => {
    const a = h('a', className, text);
    a.href = route({ view: 'business', ...patch });
    a.dataset.businessFocus = a.href;
    a.onclick = (event) => {
      if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      actions.navigate({ view: 'business', ...patch });
    };
    return a;
  };
  const home = {
    block: null,
    flow: null,
    step: null,
    tab: null,
    source: null,
    branches: null,
    related: null,
  };
  const crumb = h('nav', 'business-breadcrumb');
  crumb.setAttribute('aria-label', '业务地图导航');
  crumb.append(link('全部业务', home));
  host.append(crumb);
  /**
   * 重建后恢复同场景滚动和可识别焦点；换流程回到页面顶部，防止旧长流程滚动位置遮住新入口。
   */
  const finish = () => {
    host.scrollTop = scroll;
    // 长流程会滚动整个页面，换板块或流程时让新入口从顶部开始。
    if (!sameScene) window.scrollTo({ top: 0, behavior: 'instant' });
    if (focusKey)
      Array.from(host.querySelectorAll<HTMLElement>('[data-business-focus]'))
        .find((node) => node.dataset.businessFocus === focusKey)
        ?.focus({ preventScroll: true });
  };
  if (!blockId) {
    const intro = h('div', 'business-intro');
    const copy = h('div');
    copy.append(
      h('span', 'business-kicker', '业务地图 / 01'),
      h('h2', '', '先选一块业务，再看它如何运转。'),
      h('p', '', '从业务板块进入，选择一个流程，沿步骤查看规则与实现代码。'),
    );
    intro.append(copy, h('span', 'business-total', `${blocks.length} 个板块`));
    host.append(intro);
    const grid = h('div', 'business-blocks');
    for (const [index, block] of blocks.entries()) {
      const card = link('', { ...home, block: block.id }, 'business-block');
      const head = h('div', 'business-block-top');
      head.append(
        h('span', 'business-number', String(index + 1).padStart(2, '0')),
        h('span', 'business-block-kind', block.system ? '基础管理' : '业务板块'),
      );
      card.append(head, h('h3', '', block.title));
      const objects = h('div', 'business-object-chips');
      for (const object of block.objects) objects.append(h('span', '', name(object)));
      card.append(objects);
      const journeys = businessJourneys(block, model);
      const preview =
        block.description ||
        journeys.map((n) => (n.kind === 'process' ? name(n) : `${name(n)}生命周期`)).join('、');
      card.append(h('p', 'business-block-description', preview || '查看业务对象与操作规则'));
      const footer = h('div', 'business-block-footer');
      footer.append(
        h(
          'span',
          '',
          `${block.objects.length} 个对象 · ${journeys.length} 个${block.processes.length ? '业务流程' : '生命周期'}`,
        ),
        h('strong', '', '进入业务 →'),
      );
      card.append(footer);
      grid.append(card);
    }
    host.append(grid);
    if (!blocks.length)
      host.append(h('p', 'business-empty', '当前还没有业务声明。可开启左侧“包含系统组织模型”查看基础管理。'));
    const foot = h('div', 'business-reading-note');
    foot.append(
      h('strong', '', '按业务阅读，随时追到代码'),
      h('p', '', '先看完整流程，再展开业务阶段、分支和关联对象；点击阶段查看规则与实现代码。'),
    );
    host.append(foot);
    finish();
    return;
  }
  const block = blocks.find((b) => b.id === blockId);
  if (!block) {
    host.append(
      h('h2', '', '这个业务板块当前不可用'),
      h('p', '', '声明可能已更新，或该板块属于隐藏的系统组织模型。'),
      link('返回全部业务', home),
    );
    finish();
    return;
  }
  crumb.append(
    h('span', '', '/'),
    link(block.title, { block: block.id, flow: null, step: null, tab: null, source: null }),
  );
  const journeys = businessJourneys(block, model);
  const flow = [...journeys, ...block.flows].find((n) => n.key === flowKey);
  const heading = h('div', 'business-scene-heading');
  const title = h('div');
  title.append(
    h('span', 'business-kicker', flow ? '流程 / 03' : '业务板块 / 02'),
    h('h2', '', flow ? (flow.kind === 'aggregate' ? `${name(flow)}生命周期` : name(flow)) : block.title),
  );
  heading.append(title);
  if (flow)
    heading.append(
      link('← 返回流程列表', { flow: null, step: null, tab: null, source: null }, 'button secondary'),
    );
  else if (block.objects[0])
    heading.append(action('查看对象与字段 ↗', () => actions.inspect(block.objects[0].key, 'structure')));
  host.append(heading);
  if (!flow) {
    if (flowKey) host.append(h('p', 'source-error', '所选流程已不存在，请选择当前声明中的入口。'));
    const objects = h('div', 'business-object-chips');
    for (const object of block.objects)
      objects.append(
        action(name(object), () => actions.inspect(object.key, 'structure'), 'object-chip-button'),
      );
    host.append(
      objects,
      h(
        'p',
        'business-scene-description',
        block.description ||
          (block.processes.length
            ? '选择完整业务流程，沿主线查看阶段、分支与关联。'
            : '按业务对象查看完整生命周期；人工、审批与外部通知分别标明。'),
      ),
    );
    if (journeys.length) {
      const grid = h('div', 'business-flow-grid business-journeys');
      for (const journey of journeys) {
        const entry = link(
          '',
          { flow: journey.key, step: null, tab: null, source: null },
          'business-flow-entry',
        );
        const stages = model.nodes.filter((n) => n.kind === 'stage' && n.attrs.process === journey.id);
        entry.append(
          h('small', '', journey.kind === 'process' ? '完整业务流程' : '按状态整理'),
          h('h4', '', journey.kind === 'process' ? name(journey) : `${name(journey)}生命周期`),
          h(
            'p',
            '',
            journey.kind === 'process'
              ? String(journey.attrs.description)
              : '查看允许的操作、状态变化与退出路径',
          ),
          h(
            'span',
            'business-flow-count',
            journey.kind === 'process' ? `${stages.length} 个业务阶段 · 查看流程 →` : '查看生命周期 →',
          ),
        );
        grid.append(entry);
      }
      host.append(grid);
    }
    const operations = h('details', 'business-operations');
    operations.open = !journeys.length;
    operations.append(h('summary', '', `具体操作与查询 · ${block.flows.length} 项`));
    for (const [title, matches] of [
      ['业务操作', block.flows.filter((n) => n.kind === 'command')],
      ['自动处理与业务查询', block.flows.filter((n) => n.kind !== 'command')],
    ] as [string, ViewNode[]][]) {
      if (!matches.length) continue;
      operations.append(h('h3', 'business-section-title', `${title} · ${matches.length}`));
      const grid = h('div', 'business-flow-grid');
      for (const node of matches) {
        const entry = link(
          '',
          { flow: node.key, step: null, tab: null, source: null },
          'business-flow-entry',
        );
        entry.append(
          h('small', '', typeName[node.kind]),
          h('h4', '', name(node)),
          h(
            'p',
            '',
            businessStateSummary(node, labels) ||
              (node.kind === 'job'
                ? `定时执行 · ${node.attrs.cron}`
                : node.kind === 'query'
                  ? '按已声明的安全读依赖查询'
                  : '接收外部通知并调用业务操作'),
          ),
          h('span', 'business-flow-count', '查看此操作及触发关系 →'),
        );
        grid.append(entry);
      }
      operations.append(grid);
    }
    if (block.flows.length) host.append(operations);
    if (!block.flows.length)
      host.append(
        h('p', 'business-empty', '该板块当前只有对象声明，还没有已注册的业务操作、查询或自动处理。'),
      );
    finish();
    return;
  }
  crumb.append(h('span', '', '/'), h('strong', '', name(flow)));
  const explicit = flow.kind === 'process';
  const lifecycle = flow.kind === 'aggregate';
  const root = explicit
    ? traceBusinessProcess(model, flow, {
        branches: params.get('branches') === '1',
        related: params.get('related') !== '0',
      })
    : lifecycle
      ? traceBusinessLifecycle(model, flow, labels)
      : traceBusinessFlow(model, flow.key)!;
  if (explicit) {
    const controls = h('div', 'business-process-controls');
    controls.append(h('p', '', String(flow.attrs.description)));
    for (const [key, label, active] of [
      ['branches', '展开取消与其他分支', params.get('branches') === '1'],
      ['related', '显示业务关联', params.get('related') !== '0'],
    ] as const) {
      if (
        key === 'branches' &&
        !model.edges.some((e) => e.kind === 'follows' && e.branch && e.from.startsWith(`stage:${flow.id}.`))
      )
        continue;
      const toggle = h('label');
      const input = h('input');
      input.type = 'checkbox';
      input.checked = active;
      input.onchange = () =>
        actions.navigate({ [key]: input.checked ? '1' : '0', step: null, tab: null, source: null });
      toggle.append(input, h('span', '', label));
      controls.append(toggle);
    }
    host.append(
      controls,
      h(
        'p',
        'business-process-legend',
        '绿色箭头：业务走向　·　棕色箭头：展开的其他分支　·　虚线：涉及的业务对象',
      ),
    );
  } else if (lifecycle)
    host.append(
      h('p', 'business-process-legend', '根据真实状态迁移整理，展示允许的操作；具体执行条件请点击查看。'),
    );
  const steps = flattenBusinessSteps(root);
  const approvals = new Map(
    steps.flatMap((step) => {
      const flow = approvalFlowForStep(model, step, labels);
      return flow ? [[step.id, flow] as const] : [];
    }),
  );
  const selected = steps.find((s) => s.id === params.get('step')) ?? root;
  if (params.get('step') && !steps.some((s) => s.id === params.get('step')))
    host.append(h('p', 'source-error', '所选步骤已不在当前链路中，下面显示当前业务入口。'));
  const showDetail = Boolean(params.get('step')) || params.get('tab') === 'code';
  const workspace = h('div', `business-workspace flow-workspace${showDetail ? ' inspecting' : ''}`);
  const direction: FlowDirection = params.get('direction') === 'lr' ? 'lr' : 'tb';
  let saved = chartScenes.get(host);
  if (saved?.scene !== scene || saved.direction !== direction) {
    const previous = saved?.scene === scene ? saved.view : undefined;
    saved = {
      scene,
      direction,
      view: {
        ...createFlowChartState(),
        expanded: previous?.expanded ?? false,
        tool: previous?.tool ?? 'select',
      },
    };
    chartScenes.set(host, saved);
  }
  const chart = createFlowChart(root, {
    name: (step) => name(step.node),
    state: (step) =>
      step.node.kind === 'stage'
        ? String(step.node.attrs.actor ?? '')
        : step.mode === 'association'
          ? step.label
          : businessStateSummary(step.node, labels),
    direction,
    selected: showDetail ? selected.id : null,
    view: saved.view,
    select: (step) => actions.navigate({ step: step.id, source: null }),
    directionChanged: (direction) => actions.navigate({ direction }),
    readable: explicit || lifecycle,
    approvals,
  });
  chartViews.set(host, chart);
  workspace.append(chart.element);
  host.append(workspace);
  if (!showDetail) {
    chart.mount();
    finish();
    return;
  }
  const detail = h('aside', 'business-detail');
  detail.setAttribute('aria-label', '业务步骤详情与代码');
  const node = selected.node;
  detail.append(h('span', 'business-kicker', '当前步骤'), h('h3', '', name(node)));
  const close = action(
    '×',
    () => actions.navigate({ step: null, tab: null, source: null }),
    'business-detail-close',
  );
  close.setAttribute('aria-label', '关闭步骤详情');
  detail.append(close);
  if (selected.boundary)
    detail.append(
      h('p', 'source-note', '后续步骤已收起，可从此操作继续查看。'),
      action('从此操作继续 →', () => {
        const nextBlock = blocks.find((b) => b.flows.some((n) => n.key === node.key));
        if (nextBlock)
          actions.navigate({ block: nextBlock.id, flow: node.key, step: null, tab: null, source: null });
        else actions.inspect(node.key, 'all');
      }),
    );
  const tabs = h('div', 'business-detail-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '步骤详情');
  const codeTab = params.get('tab') === 'code';
  for (const [value, text] of [
    ['business', '业务说明'],
    ['code', '实现代码'],
  ]) {
    const tab = action(
      text,
      () => actions.navigate({ step: selected.id, tab: value }),
      codeTab === (value === 'code') ? 'active' : '',
    );
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(codeTab === (value === 'code')));
    tab.dataset.businessFocus = `tab:${value}`;
    tab.tabIndex = codeTab === (value === 'code') ? 0 : -1;
    tab.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 'business'
          : event.key === 'End'
            ? 'code'
            : value === 'code'
              ? 'business'
              : 'code';
      actions.navigate({ step: selected.id, tab: next });
      host.querySelector<HTMLElement>(`[data-business-focus="tab:${next}"]`)?.focus({ preventScroll: true });
    };
    tabs.append(tab);
  }
  detail.append(tabs);
  const implementations = [
    ...new Map(
      (['stage', 'state', 'entry'].includes(node.kind)
        ? [...selected.via, node]
        : [node, ...selected.via]
      ).map((n) => [n.key, n]),
    ).values(),
  ];
  for (const approval of implementations.filter((n) => n.kind === 'approval'))
    for (const edge of model.edges.filter((e) => e.to === approval.key && e.kind === 'binds')) {
      const route = model.nodes.find((n) => n.key === edge.from && n.kind === 'route');
      if (route) implementations.push(route);
    }
  if (codeTab) {
    const sources = h('div', 'business-source-picker');
    const source = implementations.find((n) => n.key === params.get('source')) ?? implementations[0];
    for (const impl of implementations)
      sources.append(
        action(
          `${typeName[impl.kind] ?? '声明'} · ${name(impl)}`,
          () => actions.navigate({ source: impl.key, step: selected.id }),
          impl === source ? 'active' : '',
        ),
      );
    detail.append(sources, sourcePreview(source.key));
  } else {
    const section = (title: string, text?: string) => {
      const section = h('section', 'business-detail-section');
      section.append(h('h4', '', title));
      if (text) section.append(h('p', '', text));
      detail.append(section);
      return section;
    };
    section(
      '这一步做什么',
      String(node.attrs.description || snapshot.presentation.descriptions?.[node.key] || '') ||
        (node.kind === 'command'
          ? businessStateSummary(node, labels)
          : node.kind === 'approval'
            ? '根据审批步骤确定执行人，再将通过或驳回结论交给相应业务操作。'
            : node.kind === 'outbound'
              ? '将业务结果映射后发送至外部系统，成功时执行声明的回写。'
              : node.kind === 'query'
                ? '通过声明的安全读依赖读取业务数据。'
                : node.kind === 'job'
                  ? `按照 ${node.attrs.cron} 调度；具体筛选与调用条件见实现。`
                  : node.kind === 'event'
                    ? '记录已发生的业务结果，供后续处理订阅。'
                    : '查看声明中的业务规则与映射。'),
    );
    if (node.kind === 'stage' && node.attrs.actor) section('由谁参与', String(node.attrs.actor));
    const relations = model.edges.filter((e) => e.kind === 'relates' && e.from === node.key);
    if (relations.length) {
      const involved = section('涉及哪些业务对象');
      for (const relation of relations)
        involved.append(
          action(
            `${relation.label} · ${name(model.nodes.find((n) => n.key === relation.to)!)} ↗`,
            () => actions.inspect(relation.to, 'structure'),
            'business-evidence',
          ),
        );
    }
    if (selected.note || selected !== root)
      section('什么时候执行', `${selected.label}${selected.note ? `。${selected.note}` : ''}`);
    if (node.kind === 'command') {
      const rules = section('执行条件');
      const actors: Record<string, string> = {
        user: '用户',
        process: '审批流程',
        external: '外部系统',
        job: '定时任务',
        reaction: '自动处理',
        system: '系统',
      };
      rules.append(
        h(
          'p',
          '',
          `调用身份：${((node.attrs.invokedBy ?? []) as string[]).map((a) => actors[a] ?? a).join('、')}`,
        ),
      );
      const constraints = (node.attrs.constraints ?? []) as string[];
      for (const constraint of constraints)
        rules.append(
          h(
            'p',
            '',
            `约束：${businessConstraintLabel(constraint, businessOwner(model, node)?.id ?? '', labels)}`,
          ),
        );
      rules.append(h('p', 'source-note', '调用还须通过服务端的权限、数据范围、状态和版本检查。'));
    }
    const approvalFlow = approvals.get(selected.id);
    if (approvalFlow) {
      const rules = section('审批步骤与条件', '顺序节点依次执行；并行分支同时开始，全部活动分支完成后汇合。条件在启动时判断。');
      /** 阅读说明与图保持同一嵌套结构，编号只作定位，不把兄弟分支写成前后执行。 */
      const describeGroups = (groups: readonly ApprovalGroup[]): HTMLElement => {
        const list = h('ol', 'business-approval-steps');
        for (const group of groups) {
          const row = h('li');
          if (group.condition) row.append(h('strong', '', `当${group.condition}时`));
          for (const task of group.tasks) {
            row.append(h('strong', '', `${task.number}. ${task.title}`));
            row.append(h('p', '', `审批人：${task.actor} · ${task.rule}`));
          }
          if (group.groups) row.append(describeGroups(group.groups));
          if (group.parallel) {
            row.append(h('strong', '', `${group.parallel.title} · AND 并行`));
            const branches = h('ul', 'business-approval-branches');
            for (const branch of group.parallel.branches) {
              const branchRow = h('li'); branchRow.append(h('strong', '', branch.title), describeGroups(branch.groups)); branches.append(branchRow);
            }
            row.append(branches, h('p', 'source-note', '各分支同时开始；全部活动分支完成 → AND 汇合后继续'));
          }
          if (group.condition) row.append(h('p', 'source-note', '条件不满足 → 跳过整组，继续后续步骤'));
          list.append(row);
        }
        return list;
      };
      const list = describeGroups(approvalFlow.groups);
      rules.append(
        list,
        h(
          'p',
          '',
          approvalFlow.route
            ? '所需步骤全部通过后继续业务；任一步骤驳回则结束本轮审批。'
            : '未抽取到绑定的审批步骤，请查看审批声明或外部流程配置。',
        ),
      );
    }
    const reads = model.edges.filter((e) => e.from === node.key && ['reads', 'queries'].includes(e.kind));
    if (reads.length)
      section(
        '读取哪些业务数据',
        reads.map((e) => name(model.nodes.find((n) => n.key === e.to)!)).join('、'),
      );
    const next = selected.children.filter((s) => s.mode !== 'association');
    if (next.length) section('接下来怎么走', next.map((s) => `${s.label}：${name(s.node)}`).join('；'));
    const evidence = section('实现依据');
    for (const impl of implementations)
      evidence.append(
        action(
          `${typeName[impl.kind] ?? '声明'} · ${name(impl)} ↗`,
          () => actions.navigate({ step: selected.id, tab: 'code', source: impl.key }),
          'business-evidence',
        ),
      );
    detail.append(
      action(
        '查看实现代码 →',
        () => actions.navigate({ step: selected.id, tab: 'code', source: null }),
        'button primary',
      ),
    );
  }
  detail.append(
    action('在完整本体中查看 ↗', () => actions.inspect(node.key, 'all'), 'business-technical-link'),
  );
  const context = action(
    '复制 AI 上下文',
    async () => {
      context.disabled = true;
      try {
        const response = await fetch(`/api/context?node=${encodeURIComponent(node.key)}&format=md`);
        if (!response.ok) throw new Error((await response.json()).error);
        await navigator.clipboard.writeText(await response.text());
        context.textContent = '已复制，粘贴给编程工具';
      } catch (error) {
        detail.append(h('p', 'source-error', `上下文复制失败：${(error as Error).message}`));
      } finally {
        context.disabled = false;
      }
    },
    'business-technical-link',
  );
  detail.append(context);
  workspace.append(detail);
  chart.mount();
  finish();
}
