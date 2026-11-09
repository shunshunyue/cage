/**
 * 不依赖模型的本体名称检索，供 CLI、agent 上下文和浏览器筛选共用。
 * 归一化标识与文案，按完整命中或英文词、相邻中文片段计算权重，并返回命中字段。
 * 结果是稳定排序的候选；不进行语义推理，无法保证理解否定、业务同义词或任意自然语言要求。
 */
// 轻量、可解释的名称检索；不调用模型，不把关键词匹配描述成“理解任意需求”。
// 中文用相邻双字作为线索，让“采购单取消”能匹配“取消采购单”，同时返回命中依据。
import { kindLabels, nodeLabel, type GraphModel, type ViewNode } from './graph-model.js';

/**
 * 一次命中说明，保存字段原值和实际匹配片段，便于 agent 核对候选来源。
 */
export interface SearchMatch {
  /** 实际命中的索引字段，用来解释召回依据。 */
  field: 'key' | 'id' | 'label' | 'description' | 'owner';
  /** 被命中的原始索引文本。 */
  value: string;
  /** 本次查询中命中的词项，不代表全文语义等价。 */
  terms: string[];
}
/**
 * 可解释检索候选，score 只是当前权重排名，不是语义置信概率。
 */
export interface GraphSearchHit {
  /** 完整节点身份，可用于后续 inspect/context 精确查询。 */
  key: string;
  /** 领域原始标识。 */
  id: string;
  /** 展示节点类型。 */
  kind: ViewNode['kind'];
  /** 节点中文显示名。 */
  label: string;
  /** 当前词法检索的排序分数，仅用于同次结果比较。 */
  score: number;
  /** 各字段的命中证据，支持 agent 评估候选相关性。 */
  matches: SearchMatch[];
}

/**
 * 统一全半角、大小写与首尾空白后进行词法比较，不改变输出中的原始标识。
 */
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim();

/**
 * 拆出英文标识词及连续中文的相邻双字片段，并稳定去重。
 * @param query 已归一化查询。
 * @returns 匹配词列表；单汉字单独保留，不执行分词模型。
 */
function searchTerms(query: string): string[] {
  const terms: string[] = query.match(/[a-z0-9_$.:/-]+/g) ?? [];
  for (const segment of query.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...segment];
    if (chars.length === 1) terms.push(segment);
    else for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(terms)];
}

/**
 * 对 key、ID、中文文案、原描述及所属对象分别评分，取最高单字段得分。
 * @param node 待匹配节点。
 * @param query 用户输入。
 * @param labels 显示覆盖。
 * @param descriptions 声明原始描述。
 * @returns 有依据的候选或 undefined；所有命中字段仍保留，不把分数当业务证明。
 */
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
/**
 * 按可选类型筛选并稳定排序名称候选。
 * @param model 展示图。
 * @param query 关键词。
 * @param labels 中文覆盖。
 * @param options 类型范围及原始描述。
 * @returns 完整候选数组，调用方负责 limit 和截断提示。
 */
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
/**
 * 供画布筛选复用名称匹配，并额外允许按中文类型名称筛选。
 * @param node 展示节点。
 * @param query 筛选文字。
 * @param labels 中文映射。
 * @returns 是否命中；空查询可匹配类型名称，不修改图。
 */
export function matchesNode(node: ViewNode, query: string, labels: Record<string, string>): boolean {
  return !!matchNode(node, query, labels, {}) || normalize(kindLabels[node.kind]).includes(normalize(query));
}
