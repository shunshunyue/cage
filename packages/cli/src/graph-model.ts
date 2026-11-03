// Web 与 AI 工具共用语义投影。这里只处理节点身份、中文名称和关系，布局留在 ui/。
// 稳定身份包含 kind，防止同名命令、状态或能力点在检索和路径中被合并。
import type { NodeKind, OntEdge, OntNode, Ontology } from './ontology.js';

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

/** graph.labels 的显示覆盖不参与本体哈希；声明内的 description 仍由抽取器
 * 按该声明的含义处理。中文展示不会替换路由、权限或数据表使用的稳定标识。 */
export function nodeLabel(node: ViewNode, labels: Record<string, string> = {}): string {
  if (node.kind === 'entry') return '新建入口';
  return labels[node.key] || String(node.attrs.title || node.attrs.description || node.id);
}

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

export function neighborhood(model: GraphModel, key: string): Set<string> {
  const connected = new Set([key]);
  for (const edge of model.edges) {
    if (edge.from === key) connected.add(edge.to);
    if (edge.to === key) connected.add(edge.from);
  }
  return connected;
}
