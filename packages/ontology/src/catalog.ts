/**
 * 运行本体的确定性检索索引。构造时建立标题、字段和双向关系索引；查询时按当前权限过滤。
 * 搜索与详情提供分页及原始 key，不使用向量推理；弱引用缓存随本体对象释放，不能缓存用户授权结果。
 */
import { cageError, type Ctx } from '@yss123/cage-kernel';
import type { RuntimeNode, RuntimeOntology } from './index.js';

/**
 * 组合节点类型与稳定 ID，避免命令/查询等同名节点碰撞。
 */
export const nodeKey = (node: RuntimeNode): string => `${node.kind}:${node.id}`;
/**
 * 模型发现阶段的精简节点摘要，完整 schema 按 key 另读。
 */
export interface OntologySummary {
  /**
   * 类型与 ID 组成的查询 key。
   */
  key: string;
  /**
   * 原始声明标识。
   */
  id: string;
  /**
   * 声明种类。
   */
  kind: RuntimeNode['kind'];
  /**
   * 有界显示标题。
   */
  title: string;
  /**
   * 关联聚合名列表。
   */
  aggregates: string[];
}
/**
 * 目录过滤与分页输入，空关键词可浏览全部授权候选。
 */
export interface OntologySearch {
  /**
   * 关键词，省略或空值浏览目录。
   */
  query?: string;
  /**
   * 限定种类，省略不限制。
   */
  kinds?: RuntimeNode['kind'][];
  /**
   * 限定关联聚合，不隐式授予其读取权。
   */
  aggregate?: string;
  /**
   * 零基分页偏移，由调用层 schema 校验。
   */
  offset?: number;
  /**
   * 期望数量，搜索及详情各有内部上限。
   */
  limit?: number;
}
/**
 * 命令按自身能力可见；其他节点需所有依赖聚合可读。可发现创建输入不要求同时授予对象 read，实际执行另行校验。
 */
export function nodeVisible(node: RuntimeNode, ctx: Ctx): boolean {
  // 获授创建命令不等于能读对象，但用户仍需发现该命令的合法参数。
  return node.kind === 'command'
    ? ctx.capabilities.has(node.id)
    : node.reads.every((name) => ctx.capabilities.has(`${name}.read`));
}
/**
 * 规范化 Unicode 和大小写，使中英文标识以同一形式参与确定性匹配。
 */
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
/**
 * 压缩显示标题并保留来源 key/聚合关联，不复制完整字段与输入 schema。
 */
const summary = (node: RuntimeNode): OntologySummary => ({
  key: nodeKey(node),
  id: node.id,
  kind: node.kind,
  title: node.title.slice(0, 300),
  aggregates: node.reads,
});
/**
 * 提取英文标识和中文整段及相邻双字词，去重后打分；没有语义向量召回。
 */
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
  /** 稳定 kind:id 到节点的索引；存声明数据，不缓存任何用户授权判断。 */
  private nodes = new Map<string, RuntimeNode>();
  /** 聚合之间的双向关系发现索引；双向可发现不表示读权限或业务写关系也是双向。 */
  private relations = new Map<string, Set<string>>();
  /** 搜索用的规范化文本和标题快照，构造时一次生成，命中后仍按当前 ctx 过滤可见性。 */
  private documents: { node: RuntimeNode; text: string; title: string }[];
  /**
   * 索引稳定本体；重复 key 立即拒绝，关系同时记录两端便于反向发现，但不改变实际读权限。
   */
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
  /**
   * 读取指定 key 并核对当前可见性；不存在与无权均返回 NOT_FOUND。
   */
  node(ctx: Ctx, key: string): RuntimeNode {
    const node = this.nodes.get(key);
    if (!node || !nodeVisible(node, ctx)) throw cageError('NOT_FOUND');
    return node;
  }
  /**
   * 先按当前权限、调用方筛选器与聚合/种类过滤，再对标题和字段打分；同分按 key 稳定排序。
   */
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
  /**
   * 返回全部合格 key 供后端预算规划；只省略摘要分页，不省略授权检查。
   */
  keys(ctx: Ctx, input: OntologySearch = {}, eligible: (node: RuntimeNode) => boolean = () => true): string[] {
    return this.hits(ctx, input, eligible).map((hit) => nodeKey(hit.node));
  }
  /**
   * 返回至多 20 条摘要及 total/nextOffset；空查询仍分页，truncated 明确提示未取完。
   */
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
  /**
   * 按 overview/fields/input/related 展开：输入 schema 保持完整，字段和关联分页。
   * 关系沿双向声明扩展但逐节点检查可见性；返回数量上限不表示其他节点不存在。
   */
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

/** 按不可变本体对象复用检索索引；弱引用随本体释放，不跨对象复用旧注册表内容。 */
const catalogs = new WeakMap<RuntimeOntology, OntologyCatalog>();
/**
 * 按本体对象复用索引，WeakMap 不延长本体生命周期；权限仍在每次方法调用时传入。
 */
export function ontologyCatalog(ontology: RuntimeOntology): OntologyCatalog {
  let catalog = catalogs.get(ontology);
  if (!catalog) {
    catalog = new OntologyCatalog(ontology);
    catalogs.set(ontology, catalog);
  }
  return catalog;
}
