import { cageError, type Ctx } from '@yss123/cage-kernel';
import type { RuntimeNode, RuntimeOntology } from './index.js';

export const nodeKey = (node: RuntimeNode): string => `${node.kind}:${node.id}`;
export interface OntologySummary {
  key: string;
  id: string;
  kind: RuntimeNode['kind'];
  title: string;
  aggregates: string[];
}
export interface OntologySearch {
  query?: string;
  kinds?: RuntimeNode['kind'][];
  aggregate?: string;
  offset?: number;
  limit?: number;
}
export function nodeVisible(node: RuntimeNode, ctx: Ctx): boolean {
  // 获授创建命令不等于能读对象，但用户仍需发现该命令的合法参数。
  return node.kind === 'command'
    ? ctx.capabilities.has(node.id)
    : node.reads.every((name) => ctx.capabilities.has(`${name}.read`));
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const summary = (node: RuntimeNode): OntologySummary => ({
  key: nodeKey(node),
  id: node.id,
  kind: node.kind,
  title: node.title.slice(0, 300),
  aggregates: node.reads,
});
function terms(query: string): string[] {
  const normalized = normalize(query),
    words: string[] = [...(normalized.match(/[a-z0-9_.-]+/g) ?? [])];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    words.push(run);
    for (let i = 0; i + 1 < run.length; i++) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words)];
}

/** 对稳定声明预建索引；完整 schema 留在后端。搜索、详情和关系均可分页，不静默截断目录。 */
export class OntologyCatalog {
  private nodes = new Map<string, RuntimeNode>();
  private relations = new Map<string, Set<string>>();
  private documents: { node: RuntimeNode; text: string; title: string }[];
  constructor(readonly ontology: RuntimeOntology) {
    this.documents = ontology.nodes.map((node) => {
      const key = nodeKey(node);
      if (this.nodes.has(key)) throw new Error(`重复本体节点：${key}`);
      this.nodes.set(key, node);
      if (node.kind === 'aggregate')
        for (const field of Object.values((node.data.fields ?? {}) as Record<string, any>)) {
          if (typeof field.relation !== 'string') continue;
          // 目录关系可双向发现；从关联对象进入也应找到引用它的业务，不改变实际读取授权。
          for (const [from, to] of [
            [node.id, field.relation],
            [field.relation, node.id],
          ]) {
            if (!this.relations.has(from)) this.relations.set(from, new Set());
            this.relations.get(from)!.add(to);
          }
        }
      const fields = Object.entries((node.data.fields ?? {}) as Record<string, any>)
        .map(([name, f]) => `${name} ${f.description ?? ''}`)
        .join(' ');
      return {
        node,
        title: normalize(`${node.id} ${node.title}`),
        text: normalize(`${key} ${node.title} ${node.reads.join(' ')} ${fields}`),
      };
    });
  }
  node(ctx: Ctx, key: string): RuntimeNode {
    const node = this.nodes.get(key);
    if (!node || !nodeVisible(node, ctx)) throw cageError('NOT_FOUND');
    return node;
  }
  private hits(ctx: Ctx, input: OntologySearch, eligible: (node: RuntimeNode) => boolean) {
    const query = normalize(input.query?.trim() ?? ''),
      words = terms(query);
    return this.documents
      .filter(
        ({ node }) =>
          nodeVisible(node, ctx) &&
          eligible(node) &&
          (!input.kinds?.length || input.kinds.includes(node.kind)) &&
          (!input.aggregate || node.reads.includes(input.aggregate)),
      )
      .map((doc) => ({
        ...doc,
        score: !query
          ? 1
          : (normalize(nodeKey(doc.node)) === query || normalize(doc.node.id) === query ? 1000 : 0) +
            words.reduce(
              (score, word) =>
                score + (doc.title.includes(word) ? Math.min(20, word.length) * 3 : doc.text.includes(word) ? 1 : 0),
              0,
            ),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || nodeKey(a.node).localeCompare(nodeKey(b.node)));
  }
  /** 服务端规划工具预算时只需 key，不受面向模型的摘要分页大小限制。 */
  keys(ctx: Ctx, input: OntologySearch = {}, eligible: (node: RuntimeNode) => boolean = () => true): string[] {
    return this.hits(ctx, input, eligible).map((hit) => nodeKey(hit.node));
  }
  search(ctx: Ctx, input: OntologySearch = {}, eligible: (node: RuntimeNode) => boolean = () => true) {
    const offset = input.offset ?? 0,
      limit = Math.max(1, Math.min(20, input.limit ?? 10));
    const hits = this.hits(ctx, input, eligible);
    return {
      query: input.query ?? '',
      total: hits.length,
      offset,
      limit,
      nextOffset: offset + limit < hits.length ? offset + limit : null,
      truncated: offset + limit < hits.length,
      items: hits.slice(offset, offset + limit).map((hit) => summary(hit.node)),
    };
  }
  describe(
    ctx: Ctx,
    key: string,
    section: 'overview' | 'fields' | 'input' | 'related' = 'overview',
    offset = 0,
    limit = 12,
  ): unknown {
    const node = this.node(ctx, key),
      base = summary(node);
    limit = Math.max(1, Math.min(30, limit));
    if (section === 'input') return { ...base, input: node.data.input ?? null };
    if (section === 'fields') {
      const fields = Object.entries((node.data.fields ?? {}) as Record<string, unknown>);
      return {
        ...base,
        total: fields.length,
        offset,
        nextOffset: offset + limit < fields.length ? offset + limit : null,
        fields: Object.fromEntries(fields.slice(offset, offset + limit)),
      };
    }
    if (section === 'related') {
      const aggregates = new Set(node.reads);
      for (const aggregate of node.reads)
        for (const related of this.relations.get(aggregate) ?? []) aggregates.add(related);
      const related = this.ontology.nodes
        .filter(
          (candidate) =>
            candidate !== node && nodeVisible(candidate, ctx) && candidate.reads.some((a) => aggregates.has(a)),
        )
        .sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)));
      return {
        ...base,
        total: related.length,
        offset,
        nextOffset: offset + limit < related.length ? offset + limit : null,
        items: related.slice(offset, offset + limit).map(summary),
      };
    }
    return {
      ...base,
      definition: Object.fromEntries(Object.entries(node.data).filter(([key]) => !['fields', 'input'].includes(key))),
      fieldCount: Object.keys((node.data.fields ?? {}) as object).length,
      hasInput: !!node.data.input,
      sections: ['overview', 'fields', 'input', 'related'],
    };
  }
}

const catalogs = new WeakMap<RuntimeOntology, OntologyCatalog>();
export function ontologyCatalog(ontology: RuntimeOntology): OntologyCatalog {
  let catalog = catalogs.get(ontology);
  if (!catalog) {
    catalog = new OntologyCatalog(ontology);
    catalogs.set(ontology, catalog);
  }
  return catalog;
}
