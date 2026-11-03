// 轻量、可解释的名称检索；不调用模型，不把关键词匹配描述成“理解任意需求”。
// 中文用相邻双字作为线索，让“采购单取消”能匹配“取消采购单”，同时返回命中依据。
import { kindLabels, nodeLabel, type GraphModel, type ViewNode } from './graph-model.js';

export interface SearchMatch {
  field: 'key' | 'id' | 'label' | 'description' | 'owner';
  value: string;
  terms: string[];
}
export interface GraphSearchHit {
  key: string;
  id: string;
  kind: ViewNode['kind'];
  label: string;
  score: number;
  matches: SearchMatch[];
}

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim();

function searchTerms(query: string): string[] {
  const terms: string[] = query.match(/[a-z0-9_$.:/-]+/g) ?? [];
  for (const segment of query.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...segment];
    if (chars.length === 1) terms.push(segment);
    else for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(terms)];
}

function matchNode(
  node: ViewNode,
  query: string,
  labels: Record<string, string>,
  descriptions: Record<string, string>,
): GraphSearchHit | undefined {
  const normalized = normalize(query);
  if (!normalized) return;
  const terms = searchTerms(normalized);
  const ownerId = ['field', 'state', 'command', 'capability', 'entry'].includes(node.kind)
    ? node.id.split('.')[0]
    : undefined;
  const fields: [SearchMatch['field'], string, number][] = [
    ['key', node.key, 18],
    ['id', node.id, 16],
    ['label', nodeLabel(node, labels), 12],
    ['description', descriptions[node.key] ?? String(node.attrs.description ?? ''), 10],
    ['owner', ownerId ? (labels[`aggregate:${ownerId}`] ?? ownerId) : '', 2],
  ];
  const matches: SearchMatch[] = [];
  let score = 0;
  for (const [field, value, weight] of fields) {
    const text = normalize(value);
    if (!text) continue;
    const exact = text === normalized;
    const whole = text.includes(normalized);
    const found = terms.filter((term) => text.includes(term));
    if (!exact && !whole && found.length === 0) continue;
    const points = exact ? weight * 100 : whole ? weight * 30 : weight * found.length;
    score = Math.max(score, points);
    matches.push({ field, value, terms: exact || whole ? [query.trim()] : found });
  }
  if (!matches.length) return;
  return { key: node.key, id: node.id, kind: node.kind, label: nodeLabel(node, labels), score, matches };
}

/** 排序稳定，结果携带命中字段；多个候选不静默合成一个“正确需求”。 */
export function searchGraphNodes(
  model: GraphModel,
  query: string,
  labels: Record<string, string> = {},
  options: { kind?: ViewNode['kind']; descriptions?: Record<string, string> } = {},
): GraphSearchHit[] {
  return model.nodes
    .filter((node) => !options.kind || node.kind === options.kind)
    .map((node) => matchNode(node, query, labels, options.descriptions ?? {}))
    .filter((hit): hit is GraphSearchHit => !!hit)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** 画布的筛选与搜索下拉共用同一匹配规则，保留按节点类型查找的用法。 */
export function matchesNode(node: ViewNode, query: string, labels: Record<string, string>): boolean {
  return !!matchNode(node, query, labels, {}) || normalize(kindLabels[node.kind]).includes(normalize(query));
}
