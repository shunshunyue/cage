/**
 * 本地图谱浏览器入口，装配业务地图、对象字段视图、完整本体以及搜索/详情交互。
 * 从 CLI 固定 HTTP 接口读取快照，复用共享投影与关系解释，URL 保存可分享选择，画布坐标保存在页面内存。
 * 仅阅读声明而不执行业务；刷新失败保留上次成功图并明确提示，源码文本通过 textContent 呈现，不执行预览内容。
 */
import type { GraphSnapshot } from '../src/graph-snapshot.js';
import type { NodeKind } from '../src/ontology.js';
import {
  kinds,
  nodeLabel,
  matchesNode,
  projectGraph,
  neighborhood,
  isSystem,
  layoutGraph,
  edgePath,
  NODE_WIDTH,
  NODE_HEIGHT,
  type ViewNode,
  type ViewEdge,
  type GraphModel,
  type Position,
} from './model.js';
import { explainEdge } from './relations.js';
import { searchGraphNodes as rankGraphNodes } from '../src/graph-search.js';
import { businessBlocks, businessConstraintLabel, businessJourneys } from '../src/graph-business.js';
import { renderBusiness, disposeBusiness, sourcePreview } from './business.js';
import {
  tableCards,
  tableOwner,
  layoutTables,
  tableEdgePath,
  fieldType,
  TABLE_WIDTH,
  TABLE_HEADER,
  TABLE_ROW,
  type TableCard,
} from './structure.js';

// 页面不引入图形框架或远程 CDN。百级声明图使用 SVG，即可保留清晰缩放、
// 键盘选择和可检查的节点语义；所有数据都由本地 CLI 抽取服务提供。
/**
 * 获取 index.html 约定的固定 DOM 锚点并标注调用方类型；这些 ID 由静态骨架提供。
 */
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const svg = document.getElementById('graph')! as unknown as SVGSVGElement;
const viewport = document.getElementById('viewport')! as unknown as SVGGElement;
const edgeLayer = document.getElementById('edges')!;
const nodeLayer = document.getElementById('nodes')!;
const ns = 'http://www.w3.org/2000/svg';

let snapshot: GraphSnapshot;
let model: GraphModel = { nodes: [], edges: [] };
let visibleNodes: ViewNode[] = [];
let visibleEdges: ViewEdge[] = [];
let positions = new Map<string, Position>();
let selected: string | null = null;
let selectedEdge: ViewEdge | null = null;
let emphasizeSelection = false;
let aggregate: string | null = null;
let focus: string | null = null;
let mode: 'structure' | 'business' | 'all' = 'business';
let cards: TableCard[] = [];
let visibleCards: TableCard[] = [];
let searchTarget: string | null = null;
let showSystem = false;
let camera = { x: 0, y: 0, scale: 1 };
const businessKinds = Object.keys(kinds).filter(
  (k) => !['field', 'state', 'capability', 'entry'].includes(k),
);
let enabled = new Set(businessKinds);
const nodeElements = new Map<string, SVGGElement>();
const edgeElements = new Map<
  string,
  {
    group: SVGGElement;
    path: SVGPathElement;
    hit: SVGPathElement;
    label: SVGGElement;
    width: number;
  }
>();

/**
 * 创建页面元素并用 textContent 写文本，避免把抽取文案当作 HTML 执行；返回未挂载节点。
 */
function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
/**
 * 创建 SVG 命名空间元素并设置属性/文本，供节点和连线绘制；不进行布局计算。
 */
function vector<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  text = '',
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.textContent = text;
  return node;
}
/**
 * 在当前展示模型按完整 key 查找节点；调用者只传入模型或检索结果中的已知 key。
 */
const byKey = (key: string) => model.nodes.find((n) => n.key === key)!;
/**
 * 使用当前快照的中文覆盖获取显示名，保留底层业务 ID。
 */
const displayName = (node: ViewNode) => nodeLabel(node, snapshot.presentation.labels);

/**
 * 按 patch 修改当前查询参数，null 表示移除，并按 replace 决定替换或新增历史。
 * 不自行重渲染；调用方必须同步页面状态，避免地址和视图分离。
 */
function address(patch: Record<string, string | null>, replace = false) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

/**
 * 切回业务视图并更新 URL、筛选及画布；仅换场景时滚到入口，窄屏选步骤时滚到详情。
 */
function navigateBusiness(patch: Record<string, string | null>) {
  const previousScene = element('business-view').dataset.scene;
  mode = 'business';
  selectedEdge = null;
  address({ view: 'business', node: null, object: null, ...patch });
  renderFilters();
  renderGraph();
  if (previousScene !== element('business-view').dataset.scene)
    element('explorer').scrollIntoView({ block: 'start' });
  if (patch.step && matchMedia('(max-width: 800px)').matches)
    element('business-view').querySelector('.business-detail')?.scrollIntoView({ block: 'start' });
}

/**
 * 从 URL 恢复可用视图、选中对象与系统开关，删除或无效节点不被强行选中。
 * 清除临时聚焦和边选择，供首次加载及浏览器前进后退复用。
 */
function restoreAddress() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  mode = view === 'structure' || view === 'all' ? view : 'business';
  const node = params.get('node');
  if (node && byKey(node)) selected = node;
  if (mode === 'structure' && selected)
    selected =
      tableOwner(cards, selected)?.node.key ?? cards.find((card) => !isSystem(card.node))?.node.key ?? null;
  const object = params.get('object');
  aggregate = model.nodes.some((n) => n.kind === 'aggregate' && n.id === object) ? object : null;
  showSystem = params.get('system') === '1';
  if (selected && mode !== 'business') showSystem ||= isSystem(byKey(selected));
  focus = null;
  selectedEdge = null;
  enabled = new Set(mode === 'all' ? Object.keys(kinds) : businessKinds);
}
// 中文字符约占两个半角字宽，不能沿用英文按字符数截断，否则标题会溢出卡片。
/**
 * 按半角/中文近似宽度截断画布短标题，超限添加省略号；不是精确字体测量。
 */
function shortName(text: string, width = 23): string {
  let result = '',
    used = 0;
  for (const char of text) {
    used += /[\u0000-\u00ff]/.test(char) ? 1 : 2;
    if (used > width) return `${result}…`;
    result += char;
  }
  return result;
}

/**
 * 将详情中的业务标识转换为可读名称；可指定类型消歧，未命中节点时尝试显示覆盖，最终保留原始值。
 */
const named = (id: unknown, kind?: NodeKind): string => {
  const node = model.nodes.find((n) => n.id === id && (!kind || n.kind === kind));
  return node
    ? displayName(node)
    : ((kind ? snapshot.presentation.labels[`${kind}:${id}`] : undefined) ?? String(id));
};

/**
 * 更新页面状态提示，空文本隐藏区域；不把错误提示写进本体快照。
 */
function notify(message: string) {
  element('notice').textContent = message;
  element('notice').hidden = !message;
}

/**
 * 读取或重新抽取快照，再重建投影、卡片与详情。
 * refresh 为 true 时调用 POST；期间禁用刷新按钮，失败保留旧图并提示其来源，finally 恢复按钮。
 */
async function load(refresh = false) {
  const button = element<HTMLButtonElement>('refresh');
  button.disabled = true;
  button.textContent = refresh ? '正在重新抽取…' : '读取中…';
  notify('');
  try {
    const response = await fetch(refresh ? '/api/refresh' : '/api/graph', {
      method: refresh ? 'POST' : 'GET',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    snapshot = data;
    model = projectGraph(snapshot.graph);
    cards = tableCards(model);
    // 边的序号可能因重新抽取而变化，清除旧边，避免把解释套到另一条关系上。
    selectedEdge = null;
    // 刷新保留用户筛选与有效选中项，已删除节点不继续显示旧详情。
    if (selected && !model.nodes.some((n) => n.key === selected)) selected = null;
    if (focus && !model.nodes.some((n) => n.key === focus)) focus = null;
    if (aggregate && !model.nodes.some((n) => n.kind === 'aggregate' && n.id === aggregate)) aggregate = null;
    if (!selected) {
      const aggregates = model.nodes.filter((n) => n.kind === 'aggregate' && !isSystem(n));
      const commands = (a: ViewNode) =>
        model.nodes.filter((n) => n.kind === 'command' && n.id.startsWith(`${a.id}.`)).length;
      selected = aggregates.sort((a, b) => commands(b) - commands(a))[0]?.key ?? model.nodes[0]?.key ?? null;
    }
    if (!refresh) restoreAddress();
    renderSummary();
    renderFilters();
    renderGraph();
    renderInspector();
    renderFindings();
  } catch (error) {
    // 抽取失败时保留上次成功的视图，并明确告诉用户它是旧数据。
    notify(
      `${snapshot ? '重新抽取失败，当前保留上次成功的图谱。' : '图谱加载失败。'}\n${(error as Error).message}`,
    );
    if (!snapshot) {
      element('health').textContent = '尚未取得图谱';
      element('updated').textContent = '修复问题后点击重新抽取';
    }
  } finally {
    button.disabled = false;
    button.textContent = '↻ 重新抽取';
    element('loading').hidden = true;
  }
}

/**
 * 从当前快照更新项目标题、节点统计和规则状态；通过只表示声明规则，不表示业务测试通过。
 */
function renderSummary() {
  element('project-name').textContent = snapshot.presentation.title;
  element('project-name').title = snapshot.project;
  document.title = `${snapshot.presentation.title} · Cage 本体图谱`;
  element('domain-path').textContent = snapshot.domain;
  element('metric-aggregates').textContent = String(
    snapshot.graph.nodes.filter((n) => n.kind === 'aggregate').length,
  );
  element('metric-nodes').textContent = String(snapshot.graph.nodes.length);
  element('metric-edges').textContent = String(snapshot.graph.edges.length);
  const errors = snapshot.findings.filter((f) => f.severity !== 'warning').length;
  const warnings = snapshot.findings.length - errors;
  element('health').textContent = errors
    ? `${errors} 个声明问题`
    : warnings
      ? `${warnings} 个检查提醒`
      : '声明与图规则通过';
  element('health-dot').classList.toggle('warning', snapshot.findings.length > 0);
  element('show-findings').hidden = !snapshot.findings.length;
  const time = new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', { hour12: false });
  element('updated').textContent = `最近抽取 ${time}`;
  const health = element('business-health');
  health.replaceChildren(html('span', '', `${element('health').textContent} · 最近抽取 ${time}`));
  if (snapshot.findings.length) {
    const findings = html('button', 'text-button', '查看声明问题 ↗');
    findings.onclick = () => element<HTMLDialogElement>('findings-dialog').showModal();
    health.append(findings);
  }
}

/**
 * 按当前视图重建板块/对象与类型筛选，回调更新内存状态并请求重绘，不修改声明。
 */
function renderFilters() {
  element('types-heading').hidden = mode !== 'all';
  element('type-filters').hidden = mode !== 'all';
  element('structure-note').hidden = mode !== 'structure';
  const aggregates = model.nodes.filter((n) => n.kind === 'aggregate' && (showSystem || !isSystem(n)));
  const blocks = businessBlocks(model, snapshot.presentation.labels, showSystem);
  element('objects-heading-label').textContent = mode === 'business' ? '业务板块' : '业务对象';
  element('aggregate-total').textContent = String(mode === 'business' ? blocks.length : aggregates.length);
  const list = element('aggregate-list');
  list.replaceChildren();
  const addAggregate = (id: string | null, label: string, count: number) => {
    const button = html('button', `aggregate-button${aggregate === id ? ' active' : ''}`);
    button.setAttribute('aria-pressed', String(aggregate === id));
    button.append(html('span', '', id ? '◇' : '⊞'), html('span', '', label), html('b', '', String(count)));
    button.onclick = () => {
      aggregate = id;
      focus = null;
      address({ view: mode, object: id });
      renderFilters();
      renderGraph();
    };
    list.append(button);
  };
  if (mode === 'business') {
    const selectedBlock = new URLSearchParams(location.search).get('block');
    for (const block of [{ id: null, title: '全部业务', count: blocks.length }, ...blocks.map(b => ({ id: b.id, title: b.title, count: businessJourneys(b, model).length }))]) {
      const button = html('a', `aggregate-button${selectedBlock === block.id ? ' active' : ''}`);
      const url = new URL(location.href);
      for (const key of ['flow', 'step', 'source', 'tab', 'node', 'object']) url.searchParams.delete(key);
      url.searchParams.set('view', 'business');
      if (block.id) url.searchParams.set('block', block.id);
      else url.searchParams.delete('block');
      button.href = url.pathname + url.search;
      button.append(
        html('span', '', block.id ? '◇' : '⊞'),
        html('span', '', block.title),
        html('b', '', String(block.count)),
      );
      button.onclick = (event) => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateBusiness({ block: block.id, flow: null, step: null, tab: null, source: null });
        element('sidebar').classList.remove('open');
        element('toggle-sidebar').setAttribute('aria-expanded', 'false');
      };
      list.append(button);
    }
  } else {
    addAggregate(null, '全部业务', aggregates.length);
    for (const a of aggregates)
      addAggregate(a.id, displayName(a), model.nodes.filter((n) => n.id.startsWith(`${a.id}.`)).length);
  }
  const filters = element('type-filters');
  filters.replaceChildren();
  for (const [kind, meta] of Object.entries(kinds)) {
    if (kind === 'entry') continue;
    const count = model.nodes.filter((n) => n.kind === kind && (showSystem || !isSystem(n))).length;
    if (!count) continue;
    const label = html('label', 'type-filter');
    const input = html('input');
    input.type = 'checkbox';
    input.checked = enabled.has(kind);
    input.setAttribute('aria-label', `显示${meta.label}`);
    input.onchange = () => {
      input.checked ? enabled.add(kind) : enabled.delete(kind);
      if (kind === 'state') input.checked ? enabled.add('entry') : enabled.delete('entry');
      renderGraph();
    };
    const dot = html('span', 'type-dot');
    dot.style.backgroundColor = meta.color;
    label.append(input, dot, html('span', '', meta.label), html('small', '', String(count)));
    filters.append(label);
  }
  element<HTMLInputElement>('system-toggle').checked = showSystem;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
}

/** 选一个聚合时，先纳入它自己的声明，再沿真实关系扩展业务链。
 * 不沿其他聚合的归属边扩散，避免选采购单却展开所有组织管理命令。 */
/**
 * 围绕指定聚合沿有限三跳显式关系收集相关节点，避免归属虚线扩散为所有组织命令。
 */
function aggregateNodes(id: string): Set<string> {
  const keys = new Set(model.nodes.filter((n) => n.id === id || n.id.startsWith(`${id}.`)).map((n) => n.key));
  for (let hop = 0; hop < 3; hop++) {
    const previous = new Set(keys);
    for (const edge of model.edges.filter((e) => !e.derived)) {
      if (previous.has(edge.from)) keys.add(edge.to);
      if (previous.has(edge.to) && ['uses', 'reads', 'queries', 'triggers'].includes(edge.kind))
        keys.add(edge.from);
    }
  }
  return keys;
}

/**
 * 按业务、结构或完整模式重建可见画布，应用类型/系统/对象/邻域筛选。
 * resetLayout 决定是否重新排布；切走业务视图先释放专属监听器，绘制不修改语义图。
 */
function renderGraph(resetLayout = true) {
  const business = mode === 'business';
  element('explorer').classList.toggle('business-mode', business);
  element('main').classList.toggle('business-page', business);
  element('business-view').hidden = !business;
  element('page-title').textContent = business ? '业务地图' : '本体图谱';
  element('page-description').textContent = business
    ? '先理解业务，再沿流程找到实现。'
    : '从声明出发，看见业务如何连接。';
  element('metric-first-label').textContent = business ? '业务板块' : '业务对象';
  element('metric-second-label').textContent = business ? '业务流程' : '声明节点';
  element('metric-third-label').textContent = business ? '业务对象' : '声明关系';
  const blocks = businessBlocks(model, snapshot.presentation.labels, showSystem);
  element('metric-aggregates').textContent = String(business ? blocks.length : cards.length);
  element('metric-nodes').textContent = String(
    business ? new Set(blocks.flatMap((b) => businessJourneys(b, model).map((n) => n.key))).size : snapshot.graph.nodes.length,
  );
  element('metric-edges').textContent = String(
    business ? blocks.flatMap((b) => b.objects).length : snapshot.graph.edges.length,
  );
  if (business) {
    renderBusiness(element('business-view'), model, snapshot, {
      showSystem,
      navigate: navigateBusiness,
      inspect: (key, view) => {
        mode = view;
        enabled = new Set(Object.keys(kinds));
        selected = key;
        selectedEdge = null;
        focus = null;
        aggregate = view === 'structure' ? byKey(key).id : null;
        showSystem ||= isSystem(byKey(key));
        address({ view, node: key, object: aggregate, system: showSystem ? '1' : null });
        renderFilters();
        renderGraph();
        renderInspector();
      },
    });
    return;
  }
  disposeBusiness(element('business-view'));
  searchTarget = null;
  const scope = aggregate ? aggregateNodes(aggregate) : null;
  const focused = focus ? neighborhood(model, focus) : null;
  visibleNodes = model.nodes.filter(
    (n) =>
      enabled.has(n.kind) &&
      (showSystem || !isSystem(n)) &&
      (!scope || scope.has(n.key)) &&
      (!focused || focused.has(n.key)),
  );
  const visible = new Set(visibleNodes.map((n) => n.key));
  visibleEdges = model.edges.filter(
    (e) => visible.has(e.from) && visible.has(e.to) && (!focus || e.from === focus || e.to === focus),
  );
  if (mode === 'structure') {
    const center = focus ? tableOwner(cards, focus) : cards.find((c) => c.node.id === aggregate);
    const focusedField = focus && byKey(focus).kind === 'field' ? focus : null;
    const refs = model.edges.filter(
      (e) =>
        e.kind === 'refs' &&
        (focusedField
          ? e.from === focusedField
          : !center || e.to === center.node.key || tableOwner(cards, e.from)?.node.key === center.node.key),
    );
    const related = center ? new Set([center.node.key]) : null;
    // 选对象后只展开直接引用它、或被它引用的对象；不沿命令与事件扩散。
    if (center)
      for (const edge of refs) {
        const source = tableOwner(cards, edge.from)!;
        if (source.node.key === center.node.key) related!.add(edge.to);
        if (edge.to === center.node.key) related!.add(source.node.key);
      }
    visibleCards = cards.filter(
      (card) => (showSystem || !isSystem(card.node)) && (!related || related.has(card.node.key)),
    );
    const keys = new Set(visibleCards.flatMap((card) => [card.node.key, ...card.fields.map((f) => f.key)]));
    visibleNodes = visibleCards.map((card) => card.node);
    visibleEdges = refs.filter((edge) => keys.has(edge.from) && keys.has(edge.to));
  }
  if (selectedEdge && !visibleEdges.some((e) => e.key === selectedEdge!.key)) {
    selectedEdge = null;
    renderInspector();
  }
  if (resetLayout)
    positions =
      mode === 'structure'
        ? layoutTables(visibleCards, visibleEdges, svg.clientWidth < 680 ? 1 : 2)
        : layoutGraph(visibleNodes, visibleEdges, focus);
  nodeLayer.replaceChildren();
  edgeLayer.replaceChildren();
  nodeElements.clear();
  edgeElements.clear();
  for (const edge of visibleEdges) {
    const explanation = explainEdge(edge, model, snapshot.presentation.labels);
    const group = vector('g', {
      class: `edge-group${edge.derived ? ' derived' : ''}`,
      tabindex: 0,
      role: 'button',
      'data-key': edge.key,
      'aria-label': `${displayName(byKey(edge.from))} → ${displayName(byKey(edge.to))}：${explanation.label}，查看关系说明`,
    });
    const path = vector('path', {
      class: 'edge',
      'marker-end': 'url(#arrow)',
    });
    // 透明描边扩大点击范围；文字牌与线属于同一按钮，鼠标和键盘看到同一解释。
    const hit = vector('path', { class: 'edge-hit' });
    const label = vector('g', { class: 'edge-label' });
    const width = explanation.label.length * 14 + 20;
    label.append(
      vector('rect', { x: -width / 2, y: -12, width, height: 24, rx: 12 }),
      vector('text', { 'text-anchor': 'middle', y: 4 }, explanation.label),
    );
    group.append(vector('title', {}, `${explanation.why}\n点击查看用途与声明依据`), hit, path, label);
    group.onclick = () => selectEdge(edge);
    group.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectEdge(edge);
      }
    };
    edgeLayer.append(group);
    edgeElements.set(edge.key, { group, path, hit, label, width });
  }
  for (const node of visibleNodes) {
    if (mode === 'structure') {
      renderTable(visibleCards.find((card) => card.node.key === node.key)!);
      continue;
    }
    const meta = kinds[node.kind];
    const g = vector('g', {
      class: 'node',
      tabindex: 0,
      role: 'button',
      'aria-label': `${meta.label} ${displayName(node)} ${node.id}`,
      'data-key': node.key,
    });
    g.append(vector('title', {}, `${meta.label} · ${displayName(node)}\n${node.id}`));
    g.append(
      vector('rect', {
        class: 'selected-ring',
        x: -5,
        y: -5,
        width: NODE_WIDTH + 10,
        height: NODE_HEIGHT + 10,
        rx: 12,
      }),
    );
    g.append(vector('rect', { class: 'node-box', width: NODE_WIDTH, height: NODE_HEIGHT, rx: 8 }));
    g.append(
      vector('rect', { x: 10, y: 14, width: 27, height: 27, rx: 6, fill: meta.color, 'fill-opacity': 0.1 }),
    );
    g.append(
      vector(
        'text',
        { class: 'node-code', x: 23.5, y: 31, 'text-anchor': 'middle', fill: meta.color },
        meta.short,
      ),
    );
    g.append(vector('text', { class: 'node-title', x: 46, y: 25 }, shortName(displayName(node), 18)));
    g.append(vector('text', { class: 'node-subtitle', x: 46, y: 40 }, shortName(node.id, 23)));
    g.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectNode(node.key);
      }
    };
    nodeLayer.append(g);
    nodeElements.set(node.key, g);
  }
  updatePositions();
  highlight();
  element('empty').hidden = visibleNodes.length > 0;
  element('view-title').textContent = focus
    ? `聚焦 · ${displayName(byKey(focus))}`
    : aggregate
      ? named(aggregate, 'aggregate')
      : '全部业务';
  element('view-count').textContent =
    mode === 'structure'
      ? ` / ${visibleCards.length} 个对象 · ${visibleCards.reduce((sum, card) => sum + card.fields.length, 0)} 个字段`
      : ` / ${visibleNodes.length} 个节点`;
  element('exit-focus').hidden = !focus;
  element('canvas-status').textContent = `${visibleEdges.filter((e) => !e.derived).length} 条声明关系`;
  element('relation-guide').textContent =
    mode === 'structure'
      ? '字段收在对象卡片内；点击字段看详情，点击引用线看连接原因。'
      : visibleEdges.length > 18
        ? '概览标注选中节点的关系；悬停或点击其他连线查看说明。'
        : '按“起点 → 关系名称 → 终点”阅读；点击连线查看为什么连接、有什么用。';
  if (mode === 'structure') {
    const hiddenRefs = model.edges.filter(
      (e) => e.kind === 'refs' && tableOwner(visibleCards, e.from) && !tableOwner(visibleCards, e.to),
    ).length;
    element('canvas-status').textContent =
      `${visibleEdges.length} 条对象引用${hiddenRefs ? ` · ${hiddenRefs} 条指向隐藏对象` : ''}`;
    element('edge-legend').textContent = '↗ 外键引用　⇄ 集合关系（非主表列）　＊ 必填';
  } else {
    element('edge-legend').replaceChildren(
      html('span', 'legend-line'),
      document.createTextNode(' 声明关系 '),
      html('span', 'legend-line dashed'),
      document.createTextNode(' 视图归属'),
    );
  }
  if (resetLayout) requestAnimationFrame(fit);
}

/** 绿色表头、逐行字段和表名保持在同一 SVG 卡片里。字段是可选择的原始节点，
 * 表头负责拖动卡片，字段点击不会误触画布拖动或把数据结构重新拆散。 */
/**
 * 为一个真实聚合绘制字段卡片，保留字段身份供点击、键盘和关系解释使用。
 * 卡片尺寸来自字段数量，敏感/可选/关系标记只展示声明事实。
 */
function renderTable(card: TableCard) {
  const { node, fields, height } = card;
  const group = vector('g', {
    class: 'node table-card',
    'data-key': node.key,
    role: 'group',
    'aria-label': `业务对象 ${displayName(node)}，${fields.length} 个字段`,
  });
  group.append(
    vector('rect', {
      class: 'table-shadow',
      x: -5,
      y: -5,
      width: TABLE_WIDTH + 10,
      height: height + 10,
      rx: 10,
    }),
  );
  group.append(vector('rect', { class: 'table-body', width: TABLE_WIDTH, height, rx: 6 }));
  const header = vector('g', {
    class: 'table-header',
    role: 'button',
    tabindex: 0,
    'aria-label': `查看业务对象 ${displayName(node)} ${node.id}`,
  });
  header.append(
    vector('path', {
      d: `M6,0H${TABLE_WIDTH - 6}Q${TABLE_WIDTH},0 ${TABLE_WIDTH},6V${TABLE_HEADER}H0V6Q0,0 6,0Z`,
    }),
  );
  header.append(
    vector('text', { x: 16, y: 34, class: 'table-icon' }, '▦'),
    vector('text', { x: 39, y: 34, class: 'table-name' }, shortName(displayName(node), 18)),
    vector(
      'text',
      { x: TABLE_WIDTH - 15, y: 33, 'text-anchor': 'end', class: 'table-id' },
      shortName(node.id, 20),
    ),
  );
  header.append(vector('title', {}, `${displayName(node)} · ${node.id}\n拖动表头移动；点击查看业务对象详情`));
  header.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectNode(node.key);
    }
  };
  group.append(header);
  for (const [index, field] of fields.entries()) {
    const code = field.id.slice(node.id.length + 1);
    const name = displayName(field);
    const row = vector('g', {
      class: 'table-field',
      transform: `translate(0,${TABLE_HEADER + index * TABLE_ROW})`,
      role: 'button',
      tabindex: 0,
      'aria-label': `字段 ${name} ${field.id}，${fieldType(field)}${field.attrs.virtual ? '，集合关系，不占主表列' : field.attrs.optional ? '，可选' : '，必填'}`,
    });
    row.append(
      vector('rect', { width: TABLE_WIDTH, height: TABLE_ROW, class: index % 2 ? 'alternate' : '' }),
    );
    row.append(
      vector(
        'text',
        { x: 14, y: 24, class: field.attrs.ref ? 'field-ref' : 'field-dot' },
        field.attrs.virtual ? '⇄' : field.attrs.ref ? '↗' : '·',
      ),
    );
    row.append(vector('text', { x: 34, y: 24, class: 'field-code' }, shortName(code, 16)));
    if (!field.attrs.optional && !field.attrs.virtual)
      row.append(vector('text', { x: 150, y: 24, class: 'field-required' }, '*'));
    row.append(
      vector('text', { x: 166, y: 24, class: 'field-name' }, shortName(name, 14)),
      vector(
        'text',
        { x: TABLE_WIDTH - 13, y: 24, 'text-anchor': 'end', class: 'field-type' },
        fieldType(field),
      ),
    );
    row.append(
      vector(
        'title',
        {},
        `${name} · ${field.id}\n${fieldType(field)}${field.attrs.virtual ? ' · 集合关系，不占主表列' : field.attrs.optional ? ' · 可选' : ' · 必填'}${field.attrs.ref ? ` · 关联 ${named(field.attrs.ref, 'aggregate')}` : ''}`,
      ),
    );
    row.onclick = (event) => {
      event.stopPropagation();
      selectNode(field.key);
    };
    row.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        selectNode(field.key);
      }
    };
    group.append(row);
    nodeElements.set(field.key, row);
  }
  const footerY = height - 34;
  group.append(vector('line', { x1: 0, x2: TABLE_WIDTH, y1: footerY, y2: footerY, class: 'table-divider' }));
  const states = model.nodes.filter((n) => n.kind === 'state' && n.id.startsWith(`${node.id}.`)).length;
  group.append(
    vector(
      'text',
      { x: 14, y: footerY + 21, class: 'table-footer' },
      `${fields.length} 字段 · ${states} 状态`,
    ),
  );
  group.append(
    vector(
      'text',
      { x: TABLE_WIDTH - 13, y: footerY + 21, 'text-anchor': 'end', class: 'table-sql' },
      shortName(String(node.attrs.table), 28),
    ),
  );
  nodeLayer.append(group);
  nodeElements.set(node.key, group);
}

/**
 * 按当前视图返回节点尺寸：对象卡片使用字段数算出的高度，普通图使用固定节点规格。
 */
const nodeSize = (key: string) =>
  mode === 'structure'
    ? { width: TABLE_WIDTH, height: tableOwner(visibleCards, key)!.height }
    : { width: NODE_WIDTH, height: NODE_HEIGHT };

/**
 * 将内存节点位置同步到 SVG 并重算连线，随后在候选线段位置选择碰撞较少的标签落点。
 * 标签仍贴近对应线，拖动只变展示坐标，不保存后端数据。
 */
function updatePositions() {
  for (const n of visibleNodes) {
    const p = positions.get(n.key)!;
    nodeElements.get(n.key)!.setAttribute('transform', `translate(${p.x},${p.y})`);
  }
  // 在曲线上选标签落点，优先避开节点和已放置标签。文字始终贴在线上，
  // 不为避让随意挪到空白区域，免得用户认错对应关系。
  const occupied = visibleNodes.map((node) => ({
    x: positions.get(node.key)!.x - 8,
    y: positions.get(node.key)!.y - 8,
    width: nodeSize(node.key).width + 16,
    height: nodeSize(node.key).height + 16,
  }));
  for (const e of visibleEdges) {
    const { path, hit, label, width } = edgeElements.get(e.key)!;
    const d =
      mode === 'structure'
        ? tableEdgePath(e, visibleCards, positions)
        : edgePath(positions.get(e.from)!, positions.get(e.to)!, e.from === e.to);
    path.setAttribute('d', d);
    hit.setAttribute('d', d);
    const length = path.getTotalLength();
    const candidates = [0.5, 0.35, 0.65, 0.23, 0.77].map((t) => {
      const p = path.getPointAtLength(length * t);
      return { x: p.x - width / 2, y: p.y - 12, width, height: 24 };
    });
    const collisions = (a: (typeof occupied)[number]) =>
      occupied.filter(
        (b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y,
      ).length;
    candidates.sort((a, b) => collisions(a) - collisions(b));
    const box = candidates[0]!;
    label.setAttribute('transform', `translate(${box.x + width / 2},${box.y + 12})`);
    occupied.push(box);
  }
}
/**
 * 同步节点/边选择高亮及无障碍状态，结构视图保留其他字段的可读对比度。
 */
function highlight() {
  const connected = selectedEdge
    ? new Set([selectedEdge.from, selectedEdge.to])
    : emphasizeSelection && selected && nodeElements.has(selected)
      ? neighborhood(model, selected)
      : null;
  for (const [key, g] of nodeElements) {
    if (mode === 'structure') {
      const owner = tableOwner(visibleCards, key)!;
      const related = selectedEdge
        ? [selectedEdge.from, selectedEdge.to].some(
            (end) => tableOwner(visibleCards, end)?.node.key === owner.node.key,
          )
        : tableOwner(visibleCards, selected ?? '')?.node.key === owner.node.key;
      g.classList.toggle(
        'selected',
        g.classList.contains('table-card') ? related : selectedEdge ? connected!.has(key) : key === selected,
      );
      // 保留其他表和字段的文字对比度，选中态用边框表达，不把整张数据字典褪成背景。
      g.classList.remove('dim');
      g.setAttribute('aria-pressed', String(!selectedEdge && key === selected));
      continue;
    }
    g.classList.toggle('selected', selectedEdge ? connected!.has(key) : key === selected);
    g.classList.toggle('dim', !!connected && !connected.has(key));
    g.setAttribute('aria-pressed', String(!selectedEdge && key === selected));
  }
  for (const e of visibleEdges) {
    const active = selectedEdge
      ? e.key === selectedEdge.key
      : e.from === selected ||
        e.to === selected ||
        (mode === 'structure' && tableOwner(cards, e.from)?.node.key === selected);
    const { group, path } = edgeElements.get(e.key)!;
    group.classList.toggle('active', active);
    group.classList.toggle('chosen', e.key === selectedEdge?.key);
    group.classList.toggle('dim', !!connected && !active);
    group.classList.toggle('show-label', visibleEdges.length <= 18 || active);
    group.setAttribute('aria-pressed', String(e.key === selectedEdge?.key));
    path.setAttribute('marker-end', active ? 'url(#arrow-active)' : 'url(#arrow)');
  }
}
/**
 * 根据节点选择切到合适业务入口或技术视图，必要时显式解除隐藏筛选再定位。
 * reveal 请求把目标带入视口，不代表执行该节点的业务操作。
 */
function selectNode(key: string, reveal = false) {
  if (mode === 'business') {
    const node = byKey(key);
    const processKey = node.kind === 'stage' ? `process:${node.attrs.process}` : key;
    const blocks = businessBlocks(model, snapshot.presentation.labels, showSystem || isSystem(byKey(key)));
    const block = blocks.find(
      (b) => b.objects.some((n) => n.key === key) || b.flows.some((n) => n.key === key) || b.processes.some(n => n.key === processKey),
    );
    if (block) {
      showSystem ||= block.system;
      navigateBusiness({
        block: block.id,
        flow: node.kind === 'aggregate' ? (businessJourneys(block, model).some(n => n.key === key) ? key : null) : processKey,
        step: node.kind === 'stage' ? key : null,
        branches: node.kind === 'stage' ? '1' : null,
        tab: null,
        source: null,
        system: showSystem ? '1' : null,
      });
      return;
    }
    mode = 'all';
    enabled = new Set(Object.keys(kinds));
    renderFilters();
    renderGraph();
  }
  searchTarget = null;
  selectedEdge = null;
  selected = key;
  emphasizeSelection = true;
  if (mode === 'structure' && !tableOwner(cards, key)) {
    mode = 'all';
    enabled = new Set(Object.keys(kinds));
    aggregate = null;
    focus = null;
    renderFilters();
    renderGraph();
  }
  if (reveal && !nodeElements.has(key)) {
    // 搜索覆盖整张图：命中隐藏类型时显式取消作用域并开启该类型，不能点击后无反应。
    const node = byKey(key);
    enabled.add(node.kind);
    showSystem ||= isSystem(node);
    aggregate = null;
    focus = null;
    renderFilters();
    renderGraph();
  }
  highlight();
  renderInspector();
  address({ view: mode, node: key, object: aggregate, system: showSystem ? '1' : null });
  if (reveal && mode === 'structure') {
    searchTarget = key;
    requestAnimationFrame(centerSearchResult);
  }
}

/** 搜索到长画布下方的字段时将该行移入视口。窄屏详情高度变化可能再次触发
 * ResizeObserver，适应画布后仍需保留搜索位置，否则字段会瞬间跳回屏幕外。 */
/**
 * 把结构视图搜索到的具体字段行移入视口，保留 resize 后的阅读目标；目标已清除则忽略旧帧。
 */
function centerSearchResult() {
  // 等待绘制期间切换视图会清除目标，这一帧就不再执行旧的搜索定位。
  if (!searchTarget) return;
  const card = tableOwner(visibleCards, searchTarget!)!;
  const position = positions.get(card.node.key)!;
  const row = card.fields.findIndex((field) => field.key === searchTarget);
  const offset =
    row >= 0
      ? TABLE_HEADER + (row + 0.5) * TABLE_ROW
      : Math.min(card.height / 2, svg.clientHeight / (2 * camera.scale));
  camera.x = svg.clientWidth / 2 - (position.x + TABLE_WIDTH / 2) * camera.scale;
  camera.y = svg.clientHeight / 2 - (position.y + offset) * camera.scale;
  applyCamera();
}

/**
 * 选中真实关系并确保两端可见；结构模式不能表达的关系切到完整本体，随后刷新解释面板。
 */
function selectEdge(edge: ViewEdge) {
  searchTarget = null;
  selectedEdge = edge;
  if (mode === 'structure' && edge.kind !== 'refs') {
    // 卡片中包含字段的关系已经用行表达；显式查看其他关系时进入完整本体，
    // 保留原始端点和上一次实现的关系解释，而不是伪造一条表间连线。
    mode = 'all';
    enabled = new Set(Object.keys(kinds));
    aggregate = null;
    focus = null;
    renderFilters();
  }
  // 右侧关系列表也包含当前筛选隐藏的邻居；选中后显式展示两端，解释有图可对照。
  if (!edgeElements.has(edge.key)) {
    for (const key of [edge.from, edge.to]) {
      const node = byKey(key);
      enabled.add(node.kind);
      showSystem ||= isSystem(node);
    }
    aggregate = null;
    focus = null;
    renderFilters();
    renderGraph();
  }
  highlight();
  renderInspector();
  element('inspector').scrollTop = 0;
}

/**
 * 渲染连线原因、用途、端点及源码依据，解释复用 CLI 的共享规则，不按布局猜测执行关系。
 */
function renderEdgeInspector(panel: HTMLElement, edge: ViewEdge) {
  const explanation = explainEdge(edge, model, snapshot.presentation.labels);
  const top = html('div', 'inspector-top');
  top.append(
    html('span', '', '关系说明'),
    html('span', '', edge.derived ? '虚线 · 视图推导' : '实线 · 声明抽取'),
  );
  panel.append(
    top,
    html('span', 'relation-category', explanation.category),
    html('h2', '', explanation.label),
  );
  const route = html('div', 'relation-route');
  for (const [index, key] of [edge.from, edge.to].entries()) {
    if (index) route.append(html('span', 'relation-arrow', `↓ ${explanation.label}`));
    const node = byKey(key);
    const button = html('button', 'relation-endpoint');
    button.title = `查看${displayName(node)}的节点详情`;
    button.append(
      html('small', '', `${index ? '终点' : '起点'} · ${kinds[node.kind].label}`),
      html('strong', '', displayName(node)),
      html('code', '', node.id),
    );
    button.onclick = () => selectNode(key, true);
    route.append(button);
  }
  panel.append(route);
  const section = (title: string, text: string) => {
    const box = html('section', 'relation-explanation');
    box.append(html('h3', '', title), html('p', '', text));
    panel.append(box);
    return box;
  };
  section('为什么连接', explanation.why);
  section('连接有什么用', explanation.purpose);
  section('箭头怎么读', explanation.direction);
  const source = section('声明依据', '以下是抽取到的声明属性，可与源码核对。');
  for (const evidence of explanation.evidence) source.append(html('div', 'source-location', evidence));
  const node = explanation.source;
  const owner = model.nodes.find((n) => n.kind === 'aggregate' && node.id.startsWith(`${n.id}.`));
  const location = node.file ? node : owner?.file ? owner : null;
  source.append(
    html(
      'p',
      'source-note',
      location
        ? `${location.file}:${location.line ?? 1}${location !== node ? '（所属业务对象声明）' : ''}`
        : '来自框架包，当前项目未记录源码位置。',
    ),
  );
}

/**
 * 重建技术详情面板，优先显示选中边，再按节点类型显示字段、规则、实现与关联入口。
 * 业务视图有独立详情故直接返回；所有动态文字通过 DOM 文本节点呈现。
 */
function renderInspector() {
  if (mode === 'business') return;
  const panel = element('inspector');
  panel.replaceChildren();
  if (selectedEdge) {
    renderEdgeInspector(panel, selectedEdge);
    return;
  }
  if (!selected) {
    panel.append(
      html('p', 'inspector-description', '选择节点查看属性，或点击连线了解为什么连接、连接有什么用。'),
    );
    return;
  }
  const node = byKey(selected),
    meta = kinds[node.kind];
  const top = html('div', 'inspector-top');
  top.append(html('span', '', '节点详情'), html('span', '', '↗'));
  panel.append(top);
  const icon = html('div', 'inspector-icon', meta.short);
  icon.style.color = meta.color;
  icon.style.backgroundColor = `${meta.color}12`;
  panel.append(icon);
  panel.append(html('h2', '', displayName(node)), html('div', 'node-identifier', node.id));
  const pill = html('span', 'kind-pill', meta.label);
  pill.style.color = meta.color;
  pill.style.backgroundColor = `${meta.color}12`;
  panel.append(pill);
  panel.append(html('p', 'inspector-description', String(node.attrs.description ?? descriptions[node.kind])));
  if (node.kind === 'aggregate') {
    const note = html('div', 'aggregate-explainer');
    note.append(
      html('strong', '', '什么是业务对象（聚合）？'),
      html(
        'p',
        '',
        '框架把一组需要一起遵守业务规则的数据和操作作为一个整体管理，技术上称为“聚合”。它包含字段、状态和命令，不一定只对应一张数据库表。',
      ),
    );
    panel.append(note);
  }
  const actions = html('div', 'inspector-actions');
  const focusButton = html('button', 'button secondary', '◎ 聚焦关联');
  focusButton.onclick = () => {
    focus = node.key;
    aggregate = null;
    if (mode === 'structure') {
      const card = tableOwner(cards, node.key)!;
      const refs = model.edges.filter(
        (edge) =>
          edge.kind === 'refs' &&
          (edge.to === card.node.key || card.fields.some((field) => field.key === edge.from)),
      );
      showSystem ||= refs.some((edge) => isSystem(byKey(edge.to)) || isSystem(byKey(edge.from)));
      renderFilters();
      renderGraph();
      return;
    }
    const adjacent = neighborhood(model, node.key);
    for (const n of model.nodes.filter((n) => adjacent.has(n.key))) {
      enabled.add(n.kind);
      showSystem ||= isSystem(n);
    }
    renderFilters();
    renderGraph();
  };
  const copy = html('button', 'button secondary', '复制标识');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(node.id);
      copy.textContent = '已复制';
    } catch (error) {
      notify(`复制失败：${(error as Error).message}`);
    }
  };
  actions.append(focusButton, copy);
  panel.append(actions);
  // 把当前节点交给编程工具时交付可追溯的文字，而不是让 AI 猜截图中的连线。
  // 入口与 CLI 使用同一上下文构建器，复制失败明确报告，保留原来的节点详情。
  const handoff = html('section', 'context-handoff');
  const contextButton = html('button', 'button secondary', '⌘ 复制 AI 上下文');
  const contextHint = html(
    'p',
    '',
    '包含业务链路、连接原因、源码位置和验证候选。基于当前图谱，改代码后先重新抽取。',
  );
  contextButton.onclick = async () => {
    contextButton.disabled = true;
    contextButton.textContent = '正在整理上下文…';
    try {
      const response = await fetch(`/api/context?node=${encodeURIComponent(node.key)}&format=md`);
      if (!response.ok) throw new Error((await response.json()).error);
      await navigator.clipboard.writeText(await response.text());
      contextButton.textContent = '✓ 已复制，粘贴给编程工具';
    } catch (error) {
      contextButton.textContent = '⌘ 复制 AI 上下文';
      notify(`上下文复制失败：${(error as Error).message}`);
    } finally {
      contextButton.disabled = false;
    }
  };
  handoff.append(contextButton, contextHint);
  panel.append(handoff);
  const section = (title: string, count?: number) => {
    const div = html('section', 'detail-section'),
      h = html('h3', '', title);
    if (count !== undefined) h.append(html('span', '', String(count)));
    div.append(h);
    panel.append(div);
    return div;
  };
  const info = section('声明属性');
  const row = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    const div = html('div', 'detail-row');
    div.append(
      html('span', '', label),
      html('span', '', typeof value === 'object' ? JSON.stringify(value) : String(value)),
    );
    info.append(div);
  };
  row('类型', meta.label);
  if (node.kind === 'aggregate') {
    row('数据表', node.attrs.table);
    const scope = node.attrs.scope as { dept?: string; owner?: string };
    row('部门范围', scope?.dept ? named(`${node.id}.${scope.dept}`, 'field') : undefined);
    row('归属字段', scope?.owner ? named(`${node.id}.${scope.owner}`, 'field') : undefined);
    row('状态数量', model.nodes.filter((n) => n.kind === 'state' && n.id.startsWith(`${node.id}.`)).length);
    row('命令数量', model.nodes.filter((n) => n.kind === 'command' && n.id.startsWith(`${node.id}.`)).length);
  } else if (node.kind === 'command') {
    const agg = node.id.split('.')[0];
    const stateName = (state: string) => (state === 'new' ? '新建' : named(`${agg}.${state}`, 'state'));
    row(
      '起始状态',
      Array.isArray(node.attrs.from)
        ? node.attrs.from.map(stateName).join('、')
        : stateName(String(node.attrs.from)),
    );
    row('目标状态', node.attrs.to ? stateName(String(node.attrs.to)) : '保持当前状态');
    // 调用身份不等于具体触发来源；只有审批绑定关系才能证明某命令承接审批结论。
    const actors: Record<string, string> = {
      user: '用户',
      process: '内部流程',
      external: '外部系统',
      job: '定时任务',
      reaction: '事件反应',
      system: '系统',
    };
    row('调用身份', (node.attrs.invokedBy as string[]).map((kind) => actors[kind] ?? kind).join('、'));
    row(
      '约束',
      (node.attrs.constraints as string[]).map((name) => constraintLabel(name, agg)).join('；') || '无',
    );
  } else {
    for (const [key, label] of Object.entries({
      event: '事件',
      command: '调用命令',
      tx: '事务边界',
      order: '同事件执行顺序',
      collection: '有界集合',
      process: '审批流程',
      cron: '调度表达式',
      connector: '连接器',
      operation: '操作',
      sensitive: '敏感类型',
      kind: '字段类型',
      ref: '引用对象',
      mappedBy: '对方外键',
      through: '自动中间表',
      virtual: '不占主表列',
      readOnly: '只读关联',
        filePolicy: '文件限制',
      optional: '可选字段',
      acquires: '获取资源',
      releases: '释放资源',
      terminal: '终态',
      initial: '初态',
    })) {
      const value = node.attrs[key];
      if (value === undefined || value === null) continue;
      row(label, detailValue(key, value));
    }
  }
  const source = section('声明位置');
  // 字段、状态没有独立源码位置时只引用所属聚合，并在文案上说明来源。
  const owner = model.nodes.find((n) => n.kind === 'aggregate' && node.id.startsWith(`${n.id}.`));
  const location = node.file ? node : owner?.file ? owner : null;
  if (location) {
    source.append(html('div', 'source-location', `${location.file}:${location.line ?? 1}`));
    if (location !== node) source.append(html('p', 'source-note', '位置来自所属业务对象声明。'));
  } else
    source.append(
      html(
        'p',
        'source-note',
        node.kind === 'entry' ? '由新建命令的迁移关系推导。' : '来自框架包，当前项目未记录源码位置。',
      ),
    );
  source.append(sourcePreview(node.key, false));
  const relations = model.edges.filter((e) => e.from === node.key || e.to === node.key);
  const relationSection = section('关联关系', relations.length);
  if (relations.length) relationSection.append(html('p', 'source-note', '点击一项，查看连接原因与用途。'));
  if (!relations.length) relationSection.append(html('p', 'source-note', '当前声明没有关联关系。'));
  for (const edge of relations) {
    const explanation = explainEdge(edge, model, snapshot.presentation.labels);
    const outgoing = edge.from === node.key;
    const target = byKey(outgoing ? edge.to : edge.from);
    const button = html('button', 'relation-button');
    const dot = html('span', 'relation-dot');
    dot.style.backgroundColor = kinds[target.kind].color;
    const text = html('div');
    text.append(
      html('strong', '', displayName(target)),
      html('small', '', `${outgoing ? '→' : '←'} ${explanation.label}`),
      html('small', 'relation-code', target.id),
    );
    button.append(dot, text, html('span', '', '解释 ›'));
    button.onclick = () => selectEdge(edge);
    relationSection.append(button);
  }
  const details = html('details');
  details.append(
    html('summary', '', '查看声明元数据'),
    html('pre', 'detail-json', JSON.stringify(node.attrs, null, 2)),
  );
  panel.append(details);
}

/** 把会直接影响阅读理解的属性值翻译为业务名称；SQL 表名、cron 和折叠的
 * 原始元数据仍保持技术原文，方便开发者核对实现。 */
/**
 * 把节点属性转成可读值，特别保留事务、集合上限和资源标签语义；未知值按字符串展示。
 */
function detailValue(key: string, value: unknown): string {
  if (key === 'collection') {
    const collection = value as { maxItems: number; orderBy: string };
    return `最多 ${collection.maxItems} 项，按 ${collection.orderBy} 排序；串行执行，失败遵循事务边界`;
  }
  if (key === 'tx') return value === 'same' ? '与触发命令共同提交或回滚' : '异步 outbox';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === 'event' || key === 'command') return named(value, key);
  if (key === 'ref') return named(value, 'aggregate');
  if (key === 'process') {
    const binding = model.nodes.find((n) => n.kind === 'approval' && n.attrs.process === value);
    return binding ? displayName(binding) : String(value);
  }
  if (key === 'connector') return named(`connector:${value}`, 'connector');
  if (key === 'acquires' || key === 'releases')
    return snapshot.presentation.labels[`resource:${value}`] ?? String(value);
  if (key === 'operation') return snapshot.presentation.labels[`operation:${value}`] ?? String(value);
  const types: Record<string, string> = {
    money: '金额',
    text: '文本',
    int: '整数',
    decimal: '小数',
    float: '浮点数',
    bool: '布尔值',
    boolean: '布尔值',
    id: '唯一标识',
    ref: '关联引用',
    hasMany: '一对多（反查）',
    manyToMany: '多对多（自动中间表）',
    list: '列表',
    json: '结构化数据',
    date: '日期',
    datetime: '日期时间',
    enum: '枚举',
    phone: '电话号码',
    email: '电子邮箱',
    name: '姓名',
  };
  return ['kind', 'sensitive'].includes(key) ? (types[String(value)] ?? String(value)) : String(value);
}

/**
 * 将约束中文解释委托共享业务规则，保证技术详情和业务地图使用同一字段口径。
 */
function constraintLabel(name: string, aggregateId: string): string {
  return businessConstraintLabel(name, aggregateId, snapshot.presentation.labels);
}

const descriptions: Record<NodeKind | 'entry', string> = {
  process: '引用真实业务声明的完整流程，区分人工下一步、自动触发和等待。',
  stage: '业务流程中的一个阶段，可展开查看规则、业务对象与实现代码。',
  aggregate: '统一管理字段、状态、业务操作和数据范围的业务对象。',
  command: '受权限和状态约束的业务写入入口。',
  event: '命令产生的领域事件，用于连接后续业务协作。',
  reaction: '订阅领域事件并调用命令，可声明资源获取与释放。',
  query: '通过已声明的读依赖查询安全视图。',
  approval: '把业务事件、审批流程与结论命令连接起来。',
  route: '代码中声明的审批步骤与分支条件。',
  job: '按调度表达式触发、显式声明读取与调用范围的任务。',
  connector: '声明第三方地址及可调用的操作。',
  outbound: '将领域事件映射为第三方调用。',
  inbound: '将验签后的外部回调映射为业务命令。',
  field: '业务字段的类型、范围与敏感属性。',
  state: '业务对象生命周期中的一个状态。',
  capability: '从聚合声明派生的访问能力点。',
  entry: '新建命令进入初始业务状态的虚拟起点。',
};

/**
 * 按当前快照展示规则错误码、原因、修复建议和位置，不自动修复源码。
 */
function renderFindings() {
  const list = element('findings-list');
  list.replaceChildren();
  for (const f of snapshot.findings) {
    const item = html('article', 'finding');
    item.append(html('code', '', f.code), html('p', '', f.reason));
    if (f.fix) item.append(html('p', '', `修复：${f.fix}`));
    if (f.at) item.append(html('small', '', f.at));
    list.append(item);
  }
}

/**
 * 复用共享排名检索节点并同时检索板块，显示有限候选和命中依据。
 * 点击候选更新导航并清空搜索框；未命中只提示换关键词，不判定业务不存在。
 */
function searchNodes() {
  const query = element<HTMLInputElement>('search').value.trim().toLowerCase();
  const results = element('search-results');
  results.replaceChildren();
  results.hidden = !query;
  if (!query) return;
  const matches = rankGraphNodes(model, query, snapshot.presentation.labels, {
    descriptions: snapshot.presentation.descriptions,
  });
  const matchingBlocks = businessBlocks(model, snapshot.presentation.labels, showSystem).filter(
    (block) => block.title.toLowerCase().includes(query) || block.id.toLowerCase().includes(query),
  );
  for (const block of matchingBlocks.slice(0, 5)) {
    const button = html('button', 'search-result');
    const names = html('span', 'search-names');
    names.append(html('strong', '', block.title), html('span', '', `${businessJourneys(block, model).length} 个业务流程`));
    button.append(html('small', '', '业务板块'), names);
    button.onclick = () => {
      navigateBusiness({ block: block.id, flow: null, step: null, tab: null, source: null });
      results.hidden = true;
      element<HTMLInputElement>('search').value = '';
    };
    results.append(button);
  }
  for (const hit of matches.slice(0, 30)) {
    const n = byKey(hit.key);
    const button = html('button', 'search-result');
    const names = html('span', 'search-names');
    names.append(html('strong', '', displayName(n)), html('span', '', n.id));
    button.append(html('small', '', kinds[n.kind].label), names);
    button.title = hit.matches
      .map((match) => `${match.field}：${match.value}（命中 ${match.terms.join('、')}）`)
      .join('\n');
    button.onclick = () => {
      selectNode(n.key, true);
      results.hidden = true;
      element<HTMLInputElement>('search').value = '';
    };
    results.append(button);
  }
  if (!matches.length && !matchingBlocks.length)
    results.append(html('div', 'search-empty', '没有匹配的业务，试试业务名称、操作或代码标识。'));
}

/**
 * 把当前平移和缩放应用到 SVG 并更新百分比显示，节点业务坐标保持不变。
 */
function applyCamera() {
  viewport.setAttribute('transform', `translate(${camera.x},${camera.y}) scale(${camera.scale})`);
  element('zoom-level').textContent = `${Math.round(camera.scale * 100)}%`;
}
/**
 * 依据可见节点实际尺寸计算居中缩放；结构视图保持字段可读下限并保留搜索行定位。
 */
function fit() {
  if (!visibleNodes.length) return;
  const bounds = svg.getBoundingClientRect();
  const xs = [...positions.values()].map((p) => p.x),
    ys = [...positions.values()].map((p) => p.y);
  const minX = Math.min(...xs),
    minY = Math.min(...ys),
    width =
      Math.max(...visibleNodes.map((node) => positions.get(node.key)!.x + nodeSize(node.key).width)) - minX,
    height =
      Math.max(...visibleNodes.map((node) => positions.get(node.key)!.y + nodeSize(node.key).height)) - minY;
  camera.scale = Math.min(
    (bounds.width - 65) / width,
    (bounds.height - 85) / height,
    mode === 'structure' ? 1 : 1.2,
  );
  // 表字段是正文，默认不把它们缩成难读的小字。长表可纵向平移，适当留白
  // 比为了容纳全图而把所有字段缩到 35% 更适合阅读。
  if (mode === 'structure')
    camera.scale = Math.max(Math.min(0.8, (bounds.width - 40) / TABLE_WIDTH), camera.scale);
  camera.x = (bounds.width - width * camera.scale) / 2 - minX * camera.scale;
  camera.y =
    (mode === 'structure'
      ? Math.max(30, (bounds.height - height * camera.scale) / 2)
      : (bounds.height - height * camera.scale) / 2 - 7) -
    minY * camera.scale;
  applyCamera();
  if (mode === 'structure' && searchTarget) centerSearchResult();
}
/**
 * 以屏幕锚点缩放并限制倍率范围，清除临时搜索吸附，避免缩放时图像突然跳到别处。
 */
function zoom(factor: number, x = svg.clientWidth / 2, y = svg.clientHeight / 2) {
  searchTarget = null;
  const scale = Math.min(2.5, Math.max(0.15, camera.scale * factor));
  camera.x = x - ((x - camera.x) * scale) / camera.scale;
  camera.y = y - ((y - camera.y) * scale) / camera.scale;
  camera.scale = scale;
  applyCamera();
}

// 指针捕获同时支持鼠标和触控。节点拖动修改布局坐标，空白拖动修改视口；
// 拖动结束不触发选择，避免移动节点时不断切换右侧详情。
let drag: { id: number; key?: string; x: number; y: number; initial: Position; moved: boolean } | null = null;
svg.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  searchTarget = null;
  // 连线由自身 click/键盘处理；不进入画布平移，否则 pointer capture 会吞掉点击。
  if ((event.target as Element).closest('.edge-group')) return;
  if ((event.target as Element).closest('.table-field')) return;
  const target = (event.target as Element).closest<SVGGElement>('.node');
  const key = target?.dataset.key;
  drag = {
    id: event.pointerId,
    key,
    x: event.clientX,
    y: event.clientY,
    initial: key ? { ...positions.get(key)! } : { ...camera },
    moved: false,
  };
  svg.setPointerCapture(event.pointerId);
  svg.classList.add('dragging');
});
svg.addEventListener('pointermove', (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.clientX - drag.x,
    dy = event.clientY - drag.y;
  drag.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
  if (drag.key) {
    positions.set(drag.key, { x: drag.initial.x + dx / camera.scale, y: drag.initial.y + dy / camera.scale });
    updatePositions();
  } else {
    camera.x = drag.initial.x + dx;
    camera.y = drag.initial.y + dy;
    applyCamera();
  }
});
/**
 * 结束本次指针拖动；只有正常 pointerup 且未移动才按点击选择，取消不触发选择。
 */
const endDrag = (event: PointerEvent) => {
  if (!drag || drag.id !== event.pointerId) return;
  if (event.type === 'pointerup' && !drag.moved) {
    if (drag.key) selectNode(drag.key);
    else {
      selected = null;
      selectedEdge = null;
      highlight();
      renderInspector();
    }
  }
  drag = null;
  svg.classList.remove('dragging');
};
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoom(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
  },
  { passive: false },
);
new ResizeObserver(() => {
  if (snapshot && mode !== 'business') {
    if (mode === 'structure') {
      positions = layoutTables(visibleCards, visibleEdges, svg.clientWidth < 680 ? 1 : 2);
      updatePositions();
    }
    fit();
  }
}).observe(svg);

/**
 * 恢复业务首页并清除 URL 中板块、流程、步骤及技术选择，保留当前抽取快照。
 */
function resetView() {
  mode = 'business';
  aggregate = null;
  focus = null;
  showSystem = false;
  enabled = new Set(businessKinds);
  address({
    view: 'business',
    block: null,
    flow: null,
    step: null,
    tab: null,
    source: null,
    node: null,
    object: null,
    system: null,
  });
  renderFilters();
  renderGraph();
}
element('reset-view').onclick = resetView;
element('reset-types').onclick = () => {
  enabled = new Set(mode === 'business' ? businessKinds : Object.keys(kinds));
  renderFilters();
  renderGraph();
};
element('exit-focus').onclick = () => {
  focus = null;
  renderGraph();
};
element<HTMLInputElement>('system-toggle').onchange = (event) => {
  showSystem = (event.target as HTMLInputElement).checked;
  aggregate = null;
  focus = null;
  address({ system: showSystem ? '1' : null });
  renderFilters();
  renderGraph();
};
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
  button.onclick = () => {
    mode = button.dataset.mode as typeof mode;
    selectedEdge = null;
    enabled = new Set(mode === 'business' ? businessKinds : Object.keys(kinds));
    focus = null;
    if (mode === 'structure' && selected)
      selected =
        tableOwner(cards, selected)?.node.key ?? cards.find((card) => !isSystem(card.node))?.node.key ?? null;
    address({
      view: mode,
      node: mode === 'business' ? null : selected,
      object: mode === 'business' ? null : aggregate,
    });
    renderFilters();
    renderGraph();
    renderInspector();
  };
});
window.addEventListener('popstate', () => {
  if (!snapshot) return;
  restoreAddress();
  renderFilters();
  renderGraph();
  renderInspector();
});
element('refresh').onclick = () => void load(true);
element('search').addEventListener('input', searchNodes);
element('search').addEventListener('focus', searchNodes);
element('search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') element('search-results').querySelector<HTMLButtonElement>('button')?.click();
  if (event.key === 'Escape') element('search-results').hidden = true;
});
document.addEventListener('pointerdown', (event) => {
  if (!(event.target as Element).closest('.search-wrap')) element('search-results').hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    !(event.target instanceof HTMLInputElement) &&
    !element<HTMLDialogElement>('findings-dialog').open
  ) {
    event.preventDefault();
    element('search').focus();
  }
});
element('zoom-in').onclick = () => zoom(1.2);
element('zoom-out').onclick = () => zoom(1 / 1.2);
element('fit').onclick = () => {
  searchTarget = null;
  fit();
};
element('relayout').onclick = () => renderGraph();
element('show-findings').onclick = () => element<HTMLDialogElement>('findings-dialog').showModal();
element('close-findings').onclick = () => element<HTMLDialogElement>('findings-dialog').close();
element('toggle-sidebar').onclick = () => {
  const open = element('sidebar').classList.toggle('open');
  element('toggle-sidebar').setAttribute('aria-expanded', String(open));
};
element('download').onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot.graph, null, 2)], { type: 'application/json' }),
  );
  const link = html('a');
  link.href = url;
  link.download = 'ontology.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
void load();
