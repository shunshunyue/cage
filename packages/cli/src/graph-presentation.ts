/**
 * 为 CLI 查询与浏览器图谱装配中文名称和标题，输入为配置与已构建注册表。
 * 先收集声明 description 和状态标签，再用 graph.labels 覆盖短标题，同时保留原描述用于检索。
 * 展示元数据与本体语义哈希分离，不改变能力点、数据表或实际路由，也不执行任何 IO。
 */
import type { Registry } from '@yss123/cage-kernel';
import type { CageConfig } from './config.js';

/**
 * 独立于本体的展示标题、覆盖标签和原始描述，用于名称检索及中文呈现。
 */
export interface GraphPresentation {
  /** 图谱页面与报告的项目标题。 */
  title: string;
  /** 以完整节点 key、模块或角色身份为键的显示覆盖。 */
  labels: Record<string, string>;
  /** 配置可覆盖短标题，检索仍保留声明原描述，避免丢失业务关键词。 */
  descriptions?: Record<string, string>;
}

/** 图谱、CLI 检索和 AI 上下文复用同一套中文名称。graph.labels 的显示覆盖
 * 与语义图分开，不被 impact 当成业务变化；配置短标题优先于声明的长描述。 */
/**
 * 收集声明文案并合并应用配置覆盖。
 * @param cfg graph.title/labels 的来源。
 * @param registry 已校验注册表。
 * @returns labels 用于展示，descriptions 保留声明原文；不修改本体哈希。
 */
export function graphPresentation(cfg: CageConfig, registry: Registry): GraphPresentation {
  const labels: Record<string, string> = {};
  const remember = (kind: string, id: string, description?: string) => {
    if (description) labels[`${kind}:${id}`] = description;
  };
  for (const a of registry.aggregates) {
    remember('aggregate', a.name, a.description);
    for (const [state, label] of Object.entries(a.states.labels)) remember('state', `${a.name}.${state}`, label);
  }
  for (const c of registry.commands) remember('command', c.capability, c.cmd.description);
  for (const e of registry.events) remember('event', e.name, e.description);
  for (const q of registry.queries) remember('query', q.name, q.description);
  for (const j of registry.jobs) remember('job', j.name, j.description);
  return {
    title: cfg.graph?.title ?? cfg.name,
    labels: { ...labels, ...cfg.graph?.labels },
    descriptions: labels,
  };
}
