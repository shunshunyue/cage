// 本体查询只消费一次抽取快照。CLI 每次重新抽取；Web 使用页面显示的快照，
// 报告明确记录时间与来源，不能把常驻页面里的旧图伪装成刚分析的代码。
import { createHash } from 'node:crypto';
import type { GraphSnapshot } from './graph-snapshot.js';
import { kindLabels, nodeLabel, projectGraph, type ViewEdge, type ViewNode } from './graph-model.js';
import { explainEdge } from './graph-relations.js';
import { searchGraphNodes, type GraphSearchHit } from './graph-search.js';

export interface SourceReference {
  file: string;
  line?: number;
  precision: 'declaration' | 'aggregate';
}
export interface GraphNodeInfo {
  key: string;
  id: string;
  kind: ViewNode['kind'];
  kindLabel: string;
  label: string;
  hash: string;
  source: SourceReference | null;
  attrs: Record<string, unknown>;
}
export interface GraphRelationInfo extends ViewEdge {
  label: string;
  why: string;
  purpose: string;
  direction: string;
  evidence: {
    basis: 'declared' | 'inferred' | 'text-match';
    entries: string[];
    source: SourceReference | null;
  };
}
export interface NodeResolution {
  selector: string;
  status: 'ok' | 'ambiguous' | 'not-found';
  candidates: GraphSearchHit[];
}

export const graphLimits = [
  '图描述业务声明及可抽取的依赖；条件分支、计算和 map 返回 null 等行为仍须阅读源码。',
  '名称检索与测试匹配是候选线索；未覆盖全部前端依赖，也不证明业务正确性或测试已通过。',
  'source.precision=aggregate 表示只定位到所属聚合声明；source=null 表示当前项目索引没有源码位置。',
];

export function graphReader(
  snapshot: GraphSnapshot,
  freshness: 'fresh-extraction' | 'displayed-snapshot' = 'fresh-extraction',
) {
  const model = projectGraph(snapshot.graph);
  const byKey = new Map(model.nodes.map((node) => [node.key, node]));
  const labels = snapshot.presentation.labels;
  const sourceOf = (node: ViewNode): SourceReference | null => {
    if (node.file) return { file: node.file, line: node.line, precision: 'declaration' };
    if (['field', 'state', 'capability', 'entry'].includes(node.kind)) {
      const owner = byKey.get(`aggregate:${node.id.split('.')[0]}`);
      if (owner?.file) return { file: owner.file, line: owner.line, precision: 'aggregate' };
    }
    return null;
  };
  const nodeInfo = (node: ViewNode): GraphNodeInfo => ({
    key: node.key,
    id: node.id,
    kind: node.kind,
    kindLabel: kindLabels[node.kind],
    label: nodeLabel(node, labels),
    hash: node.hash,
    source: sourceOf(node),
    attrs: node.attrs,
  });
  const relationInfo = (edge: ViewEdge): GraphRelationInfo => {
    const explanation = explainEdge(edge, model, labels);
    return {
      ...edge,
      label: explanation.label,
      why: explanation.why,
      purpose: explanation.purpose,
      direction: explanation.direction,
      evidence: {
        basis: explanation.basis,
        entries: explanation.evidence,
        source: sourceOf(explanation.source),
      },
    };
  };
  const search = (query: string, kind?: ViewNode['kind']) =>
    searchGraphNodes(model, query, labels, { kind, descriptions: snapshot.presentation.descriptions });
  const resolve = (selector: string): NodeResolution => {
    const query = selector.normalize('NFKC').trim().toLowerCase();
    // 先匹配带类型的完整身份，再匹配裸 ID / 中文全称。歧义时返回候选，不偷选第一项。
    const keyed = model.nodes.filter((n) => n.key.normalize('NFKC').toLowerCase() === query);
    const exact = keyed.length
      ? keyed
      : model.nodes.filter((n) => n.id.normalize('NFKC').toLowerCase() === query);
    const named = exact.length
      ? exact
      : model.nodes.filter((n) => nodeLabel(n, labels).normalize('NFKC').toLowerCase() === query);
    const hits = search(selector);
    const candidates = named.length
      ? named.map((n) => hits.find((hit) => hit.key === n.key)!)
      : hits.slice(0, 8);
    return {
      selector,
      status: named.length === 1 ? 'ok' : named.length > 1 ? 'ambiguous' : 'not-found',
      candidates,
    };
  };
  const meta = {
    schemaVersion: 1 as const,
    project: snapshot.project,
    domain: snapshot.domain,
    extractedAt: snapshot.generatedAt,
    freshness,
    graphHash: createHash('sha256').update(JSON.stringify(snapshot.graph)).digest('hex').slice(0, 16),
    findings: snapshot.findings,
    limitations: graphLimits,
  };
  return { model, byKey, meta, sourceOf, nodeInfo, relationInfo, search, resolve };
}

export function searchGraph(
  snapshot: GraphSnapshot,
  query: string,
  options: { limit?: number; kind?: ViewNode['kind'] } = {},
) {
  const reader = graphReader(snapshot);
  const hits = reader.search(query, options.kind);
  const limit = options.limit ?? 10;
  return {
    ...reader.meta,
    operation: 'search' as const,
    status: hits.length ? ('ok' as const) : ('not-found' as const),
    query,
    total: hits.length,
    truncated: hits.length > limit,
    hits: hits
      .slice(0, limit)
      .map((hit) => ({ ...hit, source: reader.sourceOf(reader.byKey.get(hit.key)!) })),
  };
}

export function inspectGraph(snapshot: GraphSnapshot, selector: string) {
  const reader = graphReader(snapshot);
  const resolution = reader.resolve(selector);
  const node = resolution.status === 'ok' ? reader.byKey.get(resolution.candidates[0].key)! : undefined;
  return {
    ...reader.meta,
    operation: 'inspect' as const,
    status: resolution.status,
    resolution,
    node: node ? reader.nodeInfo(node) : null,
    relations: node
      ? reader.model.edges
          .filter(
            (edge) =>
              edge.from === node.key ||
              edge.to === node.key ||
              (edge.kind === 'transition' && edge.via === node.id && node.kind === 'command'),
          )
          .map(reader.relationInfo)
      : [],
  };
}

export interface GraphPathStep {
  from: string;
  to: string;
  traversal: 'forward' | 'reverse';
  relation: GraphRelationInfo;
}

/** 默认沿箭头找最短关系链；双向探索要显式选择 both，每一步保留原箭头。
 * 归属虚线只用于整理对象，不能借它制造“任意两个命令都会互相调用”的短路。 */
export function findGraphPath(
  snapshot: GraphSnapshot,
  from: string,
  to: string,
  options: { direction?: 'out' | 'both'; depth?: number } = {},
) {
  const reader = graphReader(snapshot);
  const start = reader.resolve(from),
    end = reader.resolve(to);
  const direction = options.direction ?? 'out',
    depth = options.depth ?? 6;
  const base = { ...reader.meta, operation: 'path' as const, from: start, to: end, direction, depth };
  const nodes: GraphNodeInfo[] = [],
    steps: GraphPathStep[] = [];
  if (start.status !== 'ok' || end.status !== 'ok')
    return {
      ...base,
      status:
        start.status === 'ambiguous' || end.status === 'ambiguous'
          ? ('ambiguous' as const)
          : ('not-found' as const),
      nodes,
      steps,
    };
  const first = start.candidates[0].key,
    last = end.candidates[0].key;
  const queue = [{ key: first, steps: [] as GraphPathStep[] }];
  const visited = new Set([first]);
  for (const current of queue) {
    if (current.key === last) {
      steps.push(...current.steps);
      nodes.push(...[first, ...steps.map((s) => s.to)].map((key) => reader.nodeInfo(reader.byKey.get(key)!)));
      return { ...base, status: 'ok' as const, nodes, steps };
    }
    if (current.steps.length >= depth) continue;
    for (const edge of reader.model.edges) {
      if (edge.derived) continue;
      const forward = edge.from === current.key;
      const next = forward
        ? edge.to
        : direction === 'both' && edge.to === current.key
          ? edge.from
          : undefined;
      if (!next || visited.has(next)) continue;
      visited.add(next);
      queue.push({
        key: next,
        steps: [
          ...current.steps,
          {
            from: current.key,
            to: next,
            traversal: forward ? 'forward' : 'reverse',
            relation: reader.relationInfo(edge),
          },
        ],
      });
    }
  }
  return { ...base, status: 'not-found-within-depth' as const, nodes, steps };
}

export const sourceText = (source: SourceReference | null) =>
  source
    ? `${source.file}${source.line ? `:${source.line}` : ''}${source.precision === 'aggregate' ? '（所属聚合）' : ''}`
    : '当前工程无源码定位，查对应依赖的公开 API';
export const evidenceLabels = { declared: '显式声明', inferred: '规则推导', 'text-match': '文本匹配线索' };

export function relationMarkdown(relation: GraphRelationInfo): string[] {
  return [
    `- ${relation.from} → ${relation.to}：${relation.label}${relation.via ? `；经 ${relation.via}` : ''}`,
    `  - 原因：${relation.why}`,
    `  - 用途：${relation.purpose}`,
    `  - 依据：${evidenceLabels[relation.evidence.basis]}；${relation.evidence.entries.join('；')}`,
    `  - 源码：${sourceText(relation.evidence.source)}`,
  ];
}

export function reportHeader(report: ReturnType<typeof graphReader>['meta'], title: string): string[] {
  return [
    `# ${title}`,
    '',
    `项目：${report.project}；抽取时间：${report.extractedAt}；图指纹：${report.graphHash}`,
    `来源：${report.freshness === 'fresh-extraction' ? '本次重新抽取' : '页面当前快照，修改代码后需重新抽取'}。`,
    '',
  ];
}

export function reportFooter(report: ReturnType<typeof graphReader>['meta']): string[] {
  return [
    '',
    '## 当前规则问题',
    '',
    ...(report.findings.length
      ? report.findings.map((f) => `- [${f.code}] ${f.at ?? ''} ${f.reason}；修复：${f.fix}`)
      : ['当前抽取未发现规则问题；未执行测试。']),
    '',
    '## 使用边界',
    '',
    ...report.limitations.map((note) => `- ${note}`),
  ];
}

type QueryReport =
  ReturnType<typeof searchGraph> | ReturnType<typeof inspectGraph> | ReturnType<typeof findGraphPath>;

export function formatGraphQuery(report: QueryReport): string {
  const lines = reportHeader(
    report,
    `Cage 本体${report.operation === 'search' ? '检索' : report.operation === 'inspect' ? '节点详情' : '关系路径'}`,
  );
  if (report.operation === 'search') {
    lines.push(
      `关键词：${report.query}；命中 ${report.total} 项${report.truncated ? '，结果已截断，可提高 --limit 或缩小关键词' : ''}。`,
      '',
    );
    for (const hit of report.hits)
      lines.push(
        `- **${hit.label}** \`${hit.key}\`（${kindLabels[hit.kind]}，得分 ${hit.score}）`,
        `  - 命中：${hit.matches.map((m) => `${m.field}=${m.value}（${m.terms.join('、')}）`).join('；')}`,
        `  - 源码：${sourceText(hit.source)}`,
      );
  } else if (report.operation === 'inspect') {
    if (report.node)
      lines.push(
        `## ${report.node.label} · ${report.node.key}`,
        '',
        `源码：${sourceText(report.node.source)}`,
        '',
        '```json',
        JSON.stringify(report.node.attrs, null, 2),
        '```',
        '',
        '## 关联原因与用途',
        '',
        ...report.relations.flatMap(relationMarkdown),
      );
    else
      lines.push(
        `节点定位：${report.status}；请从候选中复制完整 key 再执行 inspect。`,
        '',
        ...report.resolution.candidates.map((hit) => `- ${hit.label} \`${hit.key}\``),
      );
  } else {
    lines.push(`路径状态：${report.status}；方向：${report.direction}；深度上限：${report.depth}。`, '');
    if (report.status === 'ok') {
      lines.push(report.nodes.map((n) => `${n.label}（${n.key}）`).join(' → '), '');
      for (const step of report.steps)
        lines.push(
          `遍历：${step.from} → ${step.to}${step.traversal === 'reverse' ? '（逆向查看依赖，不表示执行方向）' : ''}`,
          ...relationMarkdown(step.relation),
          '',
        );
    } else {
      lines.push(
        '未得到路径；未命中时缩小到完整 key，有歧义时从以下候选选择。已定位两端时可提高 --depth，或使用 --direction both 探索反向依赖。',
        '',
        ...[report.from, report.to].flatMap((r) => [
          `${r.selector}：${r.status}`,
          ...r.candidates.map((hit) => `- ${hit.label} \`${hit.key}\``),
        ]),
      );
    }
  }
  if (report.status === 'not-found')
    lines.push('', '未命中精确节点；检索基于已注册声明和名称，尝试更短的中文词或代码标识。');
  return [...lines, ...reportFooter(report)].join('\n');
}
