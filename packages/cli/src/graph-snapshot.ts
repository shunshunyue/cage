// 图谱每次刷新都在独立进程抽取。ESM 会缓存 domain 及其依赖；只给入口添加
// 时间戳无法刷新所有间接导入，因此不在常驻 Web 服务里重复 import domain。
import { analyze } from './analyze.js';
import { loadConfig } from './config.js';
import type { Finding } from './findings.js';
import type { Ontology } from './ontology.js';

export interface GraphSnapshot {
  project: string;
  domain: string;
  generatedAt: string;
  graph: Ontology;
  findings: Finding[];
  presentation: { title: string; labels: Record<string, string> };
}

async function collect() {
  const cfg = loadConfig(process.argv[2]);
  const result = await analyze(cfg, { write: true });
  if (!result.graph) {
    throw new Error(result.findings.map((f) => `[${f.code}] ${f.reason}`).join('\n'));
  }
  // 优先复用声明已有的描述。图谱文案单独传递，不给本体节点改名或改哈希，
  // 避免一次中文标题调整被误认为命令、能力点或数据库结构发生变化。
  const labels: Record<string, string> = {};
  const remember = (kind: string, id: string, description?: string) => {
    if (description) labels[`${kind}:${id}`] = description;
  };
  const registry = result.registry!;
  for (const a of registry.aggregates) remember('aggregate', a.name, a.description);
  for (const c of registry.commands) remember('command', c.capability, c.cmd.description);
  for (const e of registry.events) remember('event', e.name, e.description);
  for (const q of registry.queries) remember('query', q.name, q.description);
  for (const j of registry.jobs) remember('job', j.name, j.description);
  // 有图规则问题时仍展示图和问题列表，开发者可以借助关系图定位错误。
  const snapshot: GraphSnapshot = {
    project: cfg.name,
    domain: cfg.domain,
    generatedAt: new Date().toISOString(),
    graph: result.graph,
    findings: result.findings,
    presentation: { title: cfg.graph?.title ?? cfg.name, labels: { ...labels, ...cfg.graph?.labels } },
  };
  process.send!({ snapshot });
}

collect()
  .catch((error: Error) => {
    process.send!({ error: error.message });
    process.exitCode = 1;
  })
  .finally(() => process.disconnect());
