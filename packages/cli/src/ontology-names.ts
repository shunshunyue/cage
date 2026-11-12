/**
 * 检查应用本体中可直接命名的业务节点，供 analyze 统一接入 check、gen、verify 和图谱。
 * 名称取自与图谱相同的声明文案及 graph.labels；字段和状态仅借所属聚合定位，不伪造成员行号。
 * 只报告当前项目可定位的声明，依赖包由其维护者负责；完整性不证明名称含义或业务关系正确。
 */
import type { CageConfig } from './config.js';
import type { Finding } from './findings.js';
import type { GraphPresentation } from './graph-presentation.js';
import type { OntNode, Ontology } from './ontology.js';

/** 支持结构化名称的节点及其真实填写位置；没有通用 description 的协作节点不强加不存在的选项。 */
const namingSources: Partial<Record<OntNode['kind'], string>> = {
  aggregate: 'aggregate 的 description',
  field: '字段的 .describe(...) 或关系选项 description',
  state: '所属聚合的 states(..., { labels: { 状态标识: 业务名称 } })',
  command: 'command 的 description',
  event: 'event 第三个参数中的 description',
  query: 'query 的 description',
  job: 'job 的 description',
};

/**
 * 检查当前应用声明是否有非空的结构化业务名称，缺失时保留稳定节点 key 和源码定位。
 * @param cfg graph.naming 为 required 时产生错误；缺省或 warn 时只警告，兼容旧应用。
 * @param graph 已抽取本体；本函数不会变更节点、关系、标识或哈希。
 * @param presentation 与图谱同一次抽取产生的名称，配置短标题优先于声明文案。
 * @returns 每个缺名节点一条 CAGE-ONTOLOGY-001；不推断语言、不从注释或前端反推业务名称。
 */
export function checkOntologyNames(cfg: CageConfig, graph: Ontology, presentation: GraphPresentation): Finding[] {
  const aggregates = new Map(graph.nodes.filter(node => node.kind === 'aggregate').map(node => [node.id, node]));
  return graph.nodes.flatMap((node): Finding[] => {
    const source = namingSources[node.kind];
    if (!source) return [];
    // 成员节点没有独立源码位置；只回到当前应用的聚合声明，不检查框架依赖的默认生命周期。
    const owner = node.kind === 'field' || node.kind === 'state' ? aggregates.get(node.id.split('.')[0]) : node;
    if (!owner?.file) return [];
    const key = `${node.kind}:${node.id}`;
    // 与 nodeLabel 一致地选择展示来源，但不能把最后回退的机器 ID 当作已经填写的名称。
    const label = presentation.labels[key] || node.attrs.title || node.attrs.description;
    if (typeof label === 'string' && label.trim()) return [];
    return [{
      code: 'CAGE-ONTOLOGY-001',
      severity: cfg.graph?.naming === 'required' ? 'error' : 'warning',
      at: `${owner.file}${owner.line ? `:${owner.line}` : ''}`,
      reason: `${key} 缺少结构化业务名称，图谱只能显示机器标识。${owner !== node ? '位置指向所属聚合，请在其中查找该成员。' : ''}`,
      fix: `按用户业务用语填写${source}；已有声明可用 cage.config.json 的 graph.labels[${JSON.stringify(key)}] 覆盖。普通注释和页面文案不会被抽取，填写位置与验收见 docs/development/guides/ontology-modeling.md。`,
    }];
  });
}
