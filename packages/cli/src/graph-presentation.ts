import type { Registry } from '@yss123/cage-kernel';
import type { CageConfig } from './config.js';

export interface GraphPresentation {
  title: string;
  labels: Record<string, string>;
  /** 配置可覆盖短标题，检索仍保留声明原描述，避免丢失业务关键词。 */
  descriptions?: Record<string, string>;
}

/** 图谱、CLI 检索和 AI 上下文复用同一套中文名称。graph.labels 的显示覆盖
 * 与语义图分开，不被 impact 当成业务变化；配置短标题优先于声明的长描述。 */
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
