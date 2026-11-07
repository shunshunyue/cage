import { existsSync, readFileSync } from 'node:fs';
import { abs, type CageConfig } from './config.js';
import { listTs } from './static-check.js';
import type { Ontology } from './ontology.js';
import type { Finding } from './findings.js';

export function budget(
  cfg: CageConfig,
  graph: Ontology,
  base?: Ontology,
): { metrics: Record<string, number | null>; findings: Finding[] } {
  const kernel = abs(cfg, 'packages/kernel/src');
  const lines = existsSync(kernel)
    ? listTs(kernel).reduce(
        (n, f) =>
          n +
          readFileSync(f, 'utf8')
            .split('\n')
            .filter((l) => l.trim() && !l.trim().startsWith('//')).length,
        0,
      )
    : null;
  const primitivesFile = abs(cfg, 'packages/kernel/src/brands.ts');
  // 使用公共词汇表计数；品牌还含内部扩展标记，不能把两者混算。
  const families: Record<string, string> = {
    CONNECTOR: 'external',
    OUTBOUND: 'external',
    INBOUND: 'external',
    ROUTE: 'approval',
    APPROVAL: 'approval',
  };
  const vocabulary = new Set(['field', 'capability', 'scope', 'constraint', 'invariant']);
  if (existsSync(primitivesFile)) {
    for (const match of readFileSync(primitivesFile, 'utf8').matchAll(
      /export const (\w+) = Symbol\.for\(/g,
    )) {
      if (['CONSUMERS', 'SYSTEM_DDL', 'RUNTIME', 'MIGRATIONS'].includes(match[1])) continue;
      vocabulary.add(families[match[1]] ?? match[1].toLowerCase());
    }
  }
  const primitives = existsSync(primitivesFile) ? vocabulary.size : null;
  const findings: Finding[] = [];
  if (lines !== null && lines > 5000)
    findings.push({
      code: 'CAGE-BUDGET-001',
      reason: `内核 ${lines} 行，超过 5000 行预算`,
      fix: '拆出扩展职责，或提交架构评审调整预算',
    });
  if (primitives !== null && primitives > 16)
    findings.push({
      code: 'CAGE-BUDGET-002',
      reason: `品牌原语 ${primitives} 个，超过 16 个预算`,
      fix: '优先使用组合子，避免新增原语',
    });
  const allowance = base?.unsafeCount ?? 0;
  if (graph.unsafeCount > allowance)
    findings.push({
      code: 'CAGE-BUDGET-003',
      reason: `unsafe 从 ${allowance} 增加到 ${graph.unsafeCount}`,
      fix: '移除新增逃生口，或在评审完成后更新受审基线',
    });
  return { metrics: { kernelLines: lines, primitives, unsafe: graph.unsafeCount }, findings };
}
