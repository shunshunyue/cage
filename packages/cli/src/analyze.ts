import { mkdirSync, writeFileSync } from 'node:fs';
import { abs, type CageConfig } from './config.js';
import { errorsOnly, type Finding } from './findings.js';
import { loadRegistry } from './load.js';
import { extract, type Ontology } from './ontology.js';
import { runRules } from './rules.js';
import { staticCheck, unexportedFindings } from './static-check.js';
import { checkProjectStructure } from './project-structure.js';
import { registrationEvidence } from './registration.js';

/** 静态检查先于模块求值；发现动态声明或 IO 时不执行模块。 */
export async function analyze(cfg: CageConfig, opts: { base?: Ontology; write?: boolean; registration?: boolean } = {}) {
  const source = staticCheck(cfg);
  source.findings.push(...checkProjectStructure(cfg));
  if (errorsOnly(source.findings).length) return { source, findings: source.findings };
  const { mod, registry } = await loadRegistry(abs(cfg, cfg.domain));
  const exportedNames = new Set(Object.keys(mod));
  // Common explicit exports need no second TS program. Resolve aliases only for apparent gaps or a full doctor report.
  const registration = opts.registration || source.sites.some(site => !exportedNames.has(site.exportName)) ? registrationEvidence(cfg, source.sites) : undefined;
  const graph = extract(registry, source.sites, source.unsafeCount);
  const findings: Finding[] = [
    ...source.findings,
    ...unexportedFindings(source.sites, registration ? new Set(registration.filter(entry => entry.exportedAs.length).map(entry => entry.name)) : exportedNames),
    ...runRules(graph, opts.base),
  ];
  if (opts.write) {
    mkdirSync(abs(cfg, '.cage'), { recursive: true });
    writeFileSync(abs(cfg, '.cage/ontology.json'), JSON.stringify(graph, null, 2) + '\n');
  }
  return { source, registry, graph, findings, registration };
}
