// 图谱的投影层和页面分离：声明数据保持原样，视图额外补充的“归属”关系
// 有独立标记。这样不会让用户把布局连线误认为框架抽取出的业务依赖。
import type { NodeKind, OntEdge, OntNode, Ontology } from '../src/ontology.js';

export const kinds: Record<
  NodeKind | 'entry',
  { label: string; color: string; short: string; column: number }
> = {
  aggregate: { label: '业务对象', color: '#197c72', short: '表', column: 0 },
  command: { label: '命令', color: '#547db2', short: '令', column: 1 },
  event: { label: '事件', color: '#c08c36', short: '事', column: 2 },
  reaction: { label: '反应', color: '#aa7288', short: '应', column: 3 },
  query: { label: '查询', color: '#648c5b', short: '查', column: 1 },
  approval: { label: '审批', color: '#9c739f', short: '审', column: 3 },
  route: { label: '审批路由', color: '#9c739f', short: '路', column: 3 },
  job: { label: '定时任务', color: '#7f82a0', short: '时', column: 0 },
  connector: { label: '连接器', color: '#b57452', short: '连', column: 4 },
  outbound: { label: '出站映射', color: '#b57452', short: '出', column: 3 },
  inbound: { label: '入站回调', color: '#b57452', short: '入', column: 4 },
  field: { label: '字段', color: '#67998f', short: '字', column: 1 },
  state: { label: '状态', color: '#898b69', short: '态', column: 2 },
  capability: { label: '能力点', color: '#81949f', short: '权', column: 1 },
  entry: { label: '新建入口', color: '#89938e', short: '+', column: 0 },
};

export const edgeLabels: Record<string, string> = {
  transition: '状态迁移',
  reads: '读取',
  emits: '发出',
  uses: '使用字段',
  triggers: '触发',
  targets: '调用目标',
  queries: '查询',
  refs: '引用',
  calls: '调用',
  binds: '审批绑定',
  field: '声明字段',
  ownership: '归属（视图推导）',
};

export interface ViewNode extends Omit<OntNode, 'kind'> {
  key: string;
  kind: NodeKind | 'entry';
}
export interface ViewEdge extends Omit<OntEdge, 'kind'> {
  key: string;
  kind: OntEdge['kind'] | 'ownership';
  derived: boolean;
}
export interface GraphModel {
  nodes: ViewNode[];
  edges: ViewEdge[];
}

/** 中文用于展示，英文仍作为复制、搜索和查源码的稳定标识。
 * 没有配置业务名称的未知节点保留原标识，不能猜测业务含义后悄悄改名。 */
export function nodeLabel(node: ViewNode, labels: Record<string, string> = {}): string {
  if (node.kind === 'entry') return '新建入口';
  return labels[node.key] || String(node.attrs.description || node.id);
}

export function matchesNode(node: ViewNode, query: string, labels: Record<string, string>): boolean {
  return `${nodeLabel(node, labels)} ${node.id} ${kinds[node.kind].label}`
    .toLowerCase()
    .includes(query.toLowerCase());
}

export function projectGraph(graph: Ontology): GraphModel {
  const nodes: ViewNode[] = graph.nodes.map((n) => ({ ...n, key: `${n.kind}:${n.id}` }));
  const edges: ViewEdge[] = [];
  // 节点身份包含 kind。能力点和命令可能同名，不能单用显示名作为 SVG 的主键。
  const find = (id: string) =>
    nodes.find((n) => n.id === id && n.kind !== 'capability') ?? nodes.find((n) => n.id === id);
  for (const e of graph.edges) {
    let from = find(e.from);
    const to = find(e.to);
    // [new] 是迁移的起点，并不属于声明状态；在视图中显式标为虚拟入口。
    if (!from && e.kind === 'transition' && e.from.endsWith('.[new]')) {
      from = { key: `entry:${e.from}`, id: e.from, kind: 'entry', hash: '', attrs: {} };
      nodes.push(from);
    }
    if (from && to)
      edges.push({ ...e, from: from.key, to: to.key, key: `edge:${edges.length}`, derived: false });
  }
  for (const n of nodes) {
    if (!['command', 'state', 'capability', 'entry'].includes(n.kind)) continue;
    const owner = nodes.find((a) => a.kind === 'aggregate' && n.id.startsWith(`${a.id}.`));
    if (owner)
      edges.push({ key: `owner:${n.key}`, kind: 'ownership', from: owner.key, to: n.key, derived: true });
  }
  return { nodes, edges };
}

export const isSystem = (n: ViewNode) => /^(User|Role|Dept)(\.|$)/.test(n.id);
export function neighborhood(model: GraphModel, key: string): Set<string> {
  const connected = new Set([key]);
  for (const e of model.edges) {
    if (e.from === key) connected.add(e.to);
    if (e.to === key) connected.add(e.from);
  }
  return connected;
}

export interface Position {
  x: number;
  y: number;
}
export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 56;

/** 按类型分组的平衡列 + 邻接排序。相同声明每次打开位置相同，没有持续运动的力导向
 * 动画；读长名称、比较刷新前后的关系时不会被随机布局打断。 */
export function layoutGraph(
  nodes: ViewNode[],
  edges: ViewEdge[],
  focusKey?: string | null,
): Map<string, Position> {
  const positions = new Map<string, Position>();
  // 小范围聚焦按关系方向排布：依赖方在左、当前节点居中、目标在右。
  // 大图继续使用平衡列，避免高连接度聚合把所有邻居挤成一条长列。
  if (focusKey && nodes.some((n) => n.key === focusKey) && nodes.length <= 12) {
    positions.set(focusKey, { x: 330, y: 0 });
    const incoming = new Set(edges.filter((e) => e.to === focusKey).map((e) => e.from));
    const neighbors = nodes.filter((n) => n.key !== focusKey);
    for (const [column, items] of [
      neighbors.filter((n) => incoming.has(n.key)),
      neighbors.filter((n) => !incoming.has(n.key)),
    ].entries()) {
      items.forEach((n, row) =>
        positions.set(n.key, { x: column * 660, y: (row - (items.length - 1) / 2) * 105 }),
      );
    }
    return positions;
  }
  // 命令通常远多于其他节点；强制“一类一列”会形成极长列，适应画布后字体
  // 小到无法阅读。保持语义排序，再均衡分列，让概览尽量利用二维空间。
  const ordered = [...nodes].sort(
    (a, b) => kinds[a.kind].column - kinds[b.kind].column || a.id.localeCompare(b.id),
  );
  const columnCount = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(nodes.length / 1.6))));
  const perColumn = Math.ceil(nodes.length / columnCount);
  const columns = Array.from({ length: columnCount }, (_, i) =>
    ordered.slice(i * perColumn, (i + 1) * perColumn),
  );
  const place = () =>
    columns.forEach((items, column) =>
      items.forEach((n, row) => {
        positions.set(n.key, { x: column * 330, y: (row - (items.length - 1) / 2) * 105 });
      }),
    );
  place();
  // 只做排序，节点仍各占一行；邻居平均纵坐标让同一业务链尽量接近。
  for (let pass = 0; pass < 4; pass++) {
    for (const items of columns) {
      const score = (node: ViewNode) => {
        const ys = edges
          .filter((e) => e.from === node.key || e.to === node.key)
          .map((e) => positions.get(e.from === node.key ? e.to : e.from)?.y)
          .filter((y): y is number => y !== undefined);
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
      };
      items.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
      place();
    }
  }
  return positions;
}

export function edgePath(from: Position, to: Position, self: boolean): string {
  if (self)
    return `M${from.x + NODE_WIDTH - 25},${from.y} C${from.x + NODE_WIDTH + 50},${from.y - 65} ${from.x + NODE_WIDTH + 50},${from.y + 100} ${from.x + NODE_WIDTH - 25},${from.y + NODE_HEIGHT}`;
  // 同列关系从右侧绕行，给标签留出空间，也避免穿过中间节点。
  if (from.x === to.x) {
    const x = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2,
      y2 = to.y + NODE_HEIGHT / 2;
    const bend = 110 + Math.abs(y2 - y1) * 0.12;
    return `M${x},${y1} C${x + bend},${y1} ${x + bend},${y2} ${x},${y2}`;
  }
  const forward = to.x >= from.x;
  const x1 = from.x + (forward ? NODE_WIDTH : 0),
    x2 = to.x + (forward ? 0 : NODE_WIDTH);
  const y1 = from.y + NODE_HEIGHT / 2,
    y2 = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(60, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
