/**
 * 声明分析总入口，供 check、gen、verify、doctor 与本体快照共同调用。
 * 先检查目录、顶层声明及禁止的 IO，再导入领域入口构建注册表、抽取本体并运行图规则。
 * 这里只求值声明，不执行命令；write 选项才会更新当前本体文件，静态错误会阻止模块求值。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { abs, type CageConfig } from './config.js';
import { errorsOnly, type Finding } from './findings.js';
import { loadRegistry } from './load.js';
import { extract, type Ontology } from './ontology.js';
import { runRules } from './rules.js';
import { staticCheck, unexportedFindings } from './static-check.js';
import { checkProjectStructure } from './project-structure.js';
import { registrationEvidence } from './registration.js';
import { graphPresentation } from './graph-presentation.js';
import { checkOntologyNames } from './ontology-names.js';

/** 静态检查先于模块求值；发现动态声明或 IO 时不执行模块。 */
/**
 * 执行当前应用的声明检查与语义抽取，不运行具体业务命令。
 * 静态错误时返回已有 source/findings；可求值时继续附注册表、本体及可选导出链。
 * @param cfg 应用目录和 domain 入口配置。
 * @param opts base 用于事件兼容检查，write 才保存当前图，registration 强制收集完整导出证据。
 * @returns 分阶段分析结果；模块导入、注册或文件 IO 异常直接抛出。
 */
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
    ...checkOntologyNames(cfg, graph, graphPresentation(cfg, registry)),
  ];
  if (opts.write) {
    mkdirSync(abs(cfg, '.cage'), { recursive: true });
    writeFileSync(abs(cfg, '.cage/ontology.json'), JSON.stringify(graph, null, 2) + '\n');
  }
  return { source, registry, graph, findings, registration };
}
