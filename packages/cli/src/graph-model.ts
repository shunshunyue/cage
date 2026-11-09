/**
 * Web 图谱与 agent 查询共用的语义投影，不负责像素布局或业务执行。
 * 把原始节点转换为带 kind 的稳定 key，按关系类型解析边端点，并补充只用于整理的归属虚线。
 * 中文标签是展示覆盖，不改变业务标识；无法解析端点的边不会伪造节点，归属推导应与显式关系区分。
 */
// Web 与 AI 工具共用语义投影。这里只处理节点身份、中文名称和关系，布局留在 ui/。
// 稳定身份包含 kind，防止同名命令、状态或能力点在检索和路径中被合并。
import type { NodeKind, OntEdge, OntNode, Ontology } from './ontology.js';

/**
 * 节点类型的固定中文词汇，CLI 报告和浏览器共用；只影响呈现，不改变本体 kind。
 */
export const kindLabels: Record<NodeKind | 'entry', string> = {
  aggregate: '业务对象',
  command: '命令',
  event: '事件',
  reaction: '反应',
  query: '查询',
  approval: '审批',
  route: '审批路由',
  job: '定时任务',
  connector: '连接器',
  outbound: '出站映射',
  inbound: '入站回调',
  field: '字段',
  state: '状态',
  capability: '能力点',
  entry: '新建入口',
  process: '业务流程',
  stage: '业务阶段',
};

/**
 * 本体及展示归属边的中文短名，未知扩展关系由具体解释层处理。
 */
export const edgeLabels: Record<string, string> = {
  transition: '状态迁移',
  reads: '读取',
  emits: '发出',
  uses: '使用字段',
  triggers: '触发',
  cancels: '取消审批',
  targets: '调用目标',
  queries: '查询',
  refs: '引用',
  calls: '调用',
  binds: '审批绑定',
  field: '声明字段',
  ownership: '归属（标识推导）',
  contains: '包含业务阶段',
  implements: '阶段实现',
  follows: '业务下一步',
  relates: '关联业务对象',
};

/**
 * 带稳定 key 的展示节点，entry 是为新建状态迁移补出的虚拟入口。
 */
export interface ViewNode extends Omit<OntNode, 'kind'> {
  /** kind:id 组成的完整身份，避免同名命令与能力点混淆。 */
  key: string;
  /** 原节点类型或状态迁移补出的虚拟 entry。 */
  kind: NodeKind | 'entry';
}
/**
 * 端点已转换为完整节点 key 的展示边，derived 区分推导归属与原始声明。
 */
export interface ViewEdge extends Omit<OntEdge, 'kind'> {
  /** 本次投影内的边身份，供选择和布局查找。 */
  key: string;
  /** 原关系类型或仅供组织展示的 ownership。 */
  kind: OntEdge['kind'] | 'ownership';
  /** true 表示推导归属，不能作为真实执行依赖证据。 */
  derived: boolean;
}
/**
 * 与布局无关的节点和边投影，供查询、规则解释及浏览器布局共享。
 */
export interface GraphModel {
  /** 包含原始节点与必要虚拟新建入口的展示节点。 */
  nodes: ViewNode[];
  /** 两端已解析为节点 key 的展示关系。 */
  edges: ViewEdge[];
}

/** graph.labels 的显示覆盖不参与本体哈希；声明内的 description 仍由抽取器
 * 按该声明的含义处理。中文展示不会替换路由、权限或数据表使用的稳定标识。 */
/**
 * 按显示覆盖、标题、description、原 ID 的顺序选择文案。
 * @param node 展示节点，虚拟 entry 固定使用新建入口文案。
 * @param labels 仅用于显示的中文映射。
 * @returns 展示名称，不修改节点或业务标识。
 */
export function nodeLabel(node: ViewNode, labels: Record<string, string> = {}): string {
  if (node.kind === 'entry') return '新建入口';
  return labels[node.key] || String(node.attrs.title || node.attrs.description || node.id);
}

/**
 * 将本体 ID 按关系端点类型转成唯一 key，并补新建入口及归属边。
 * @param graph 原始本体，不会被修改。
 * @returns 新展示模型；无法匹配两端的关系不输出，派生 ownership 不代表调用。
 */
export function projectGraph(graph: Ontology): GraphModel {
  const nodes: ViewNode[] = graph.nodes.map((n) => ({ ...n, key: `${n.kind}:${n.id}` }));
  const edges: ViewEdge[] = [];
  const find = (id: string, kinds: ViewNode['kind'][]) =>
    nodes.find((n) => n.id === id && kinds.includes(n.kind));
  // 原始边以业务 ID 存端点；投影时按关系类型恢复端点身份，不能猜成同名的状态或能力点。
  const endpoints: Record<OntEdge['kind'], [ViewNode['kind'][], ViewNode['kind'][]]> = {
    transition: [['state', 'entry'], ['state']],
    field: [['aggregate'], ['field']],
    refs: [['field'], ['aggregate']],
    reads: [['command'], ['aggregate']],
    queries: [['query', 'job'], ['aggregate']],
    emits: [['command'], ['event']],
    triggers: [['event'], ['reaction', 'approval', 'outbound']],
    cancels: [['event'], ['approval']],
    targets: [
      ['reaction', 'outbound', 'inbound'],
      ['command', 'connector'],
    ],
    calls: [['job'], ['command']],
    binds: [
      ['route', 'approval'],
      ['approval', 'command'],
    ],
    uses: [['command', 'event', 'query', 'approval', 'route', 'outbound'], ['field']],
    contains: [['process'], ['stage']],
    implements: [['stage'], ['command', 'event', 'reaction', 'query', 'approval', 'job', 'inbound', 'outbound']],
    follows: [['stage'], ['stage']],
    relates: [['process', 'stage'], ['aggregate']],
  };
  for (const edge of graph.edges) {
    const [fromKinds, toKinds] = endpoints[edge.kind];
    let from = find(edge.from, edge.fromKind ? [edge.fromKind] : fromKinds);
    const to = find(edge.to, edge.toKind ? [edge.toKind] : toKinds);
    if (!from && edge.kind === 'transition' && edge.from.endsWith('.[new]')) {
      from = { key: `entry:${edge.from}`, id: edge.from, kind: 'entry', hash: '', attrs: {} };
      nodes.push(from);
    }
    if (from && to)
      edges.push({ ...edge, from: from.key, to: to.key, key: `edge:${edges.length}`, derived: false });
  }
  for (const node of nodes) {
    if (!['command', 'state', 'capability', 'entry'].includes(node.kind)) continue;
    const owner = nodes.find((n) => n.kind === 'aggregate' && node.id.startsWith(`${n.id}.`));
    if (owner)
      edges.push({
        key: `owner:${node.key}`,
        kind: 'ownership',
        from: owner.key,
        to: node.key,
        derived: true,
      });
  }
  return { nodes, edges };
}

/**
 * 计算节点的一跳无向邻域，供画布高亮。
 * @param model 展示图。
 * @param key 完整节点身份。
 * @returns 包含自身和直接邻居的集合；不继续传递，不区分执行方向。
 */
export function neighborhood(model: GraphModel, key: string): Set<string> {
  const connected = new Set([key]);
  for (const edge of model.edges) {
    if (edge.from === key) connected.add(edge.to);
    if (edge.to === key) connected.add(edge.from);
  }
  return connected;
}
