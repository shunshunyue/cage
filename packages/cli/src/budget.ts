/**
 * 面向框架维护和业务门禁计算内核规模、公共词汇与 unsafe 增量预算。
 * 读取本地源码及本体元数据，返回 metrics 和 Finding，不修改源码、不连接数据库。
 * 源码包不存在时对应体积指标为 null；体积按含语法 token 的物理行计数，排除注释和空白。
 */
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { abs, type CageConfig } from './config.js';
import { listTs } from './static-check.js';
import type { Ontology } from './ontology.js';
import type { Finding } from './findings.js';

/**
 * 统计一份 TypeScript 源码实际占用的代码行，让中文 JSDoc 不消耗内核实现预算。
 * 使用语法树的叶子 token 定位原始物理行，不重新格式化源码，也不把字符串、正则或模板内的注释符当注释。
 * JSDoc 子树和 EOF 不代表实现；跨行 token 覆盖的全部行仍计入，因此模板文字中的空行属于代码内容。
 * 同一行有多个 token 只计一次，行尾注释不增加行数；本函数不做类型检查或修改文件。
 * @param file 文件名，交给 TypeScript 判断源码类型。
 * @param sourceText 完整源码，保留原有换行。
 * @returns 含至少一个语法 token 的物理行数。
 */
function codeLineCount(file: string, sourceText: string): number {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  /** 遍历语法 token；必须跳过 JSDoc 整棵子树，避免其中的标识符和类型被当作实现。 */
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length) {
      children.forEach(visit);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.kind === ts.SyntaxKind.SyntaxList) return;
    const start = node.getStart(source), end = node.getEnd();
    if (end <= start) return;
    const first = source.getLineAndCharacterOfPosition(start).line;
    const last = source.getLineAndCharacterOfPosition(end - 1).line;
    for (let line = first; line <= last; line++) lines.add(line);
  };
  visit(source);
  return lines.size;
}

/**
 * 计算静态预算并给出超限诊断，不自动豁免或改写基线。
 * @param cfg 用于查找本地 kernel 源码；普通安装项目可能没有这些文件。
 * @param graph 当前本体，其中 unsafeCount 表示扫描到的逃生口数量。
 * @param base 已审查本体，省略时 unsafe 允许量为零。
 * @returns 体积/词汇/unsafe 指标和超限 Finding；缺源码的指标为 null。
 */
export function budget(
  cfg: CageConfig,
  graph: Ontology,
  base?: Ontology,
): { metrics: Record<string, number | null>; findings: Finding[] } {
  const kernel = abs(cfg, 'packages/kernel/src');
  const lines = existsSync(kernel)
    ? listTs(kernel).reduce(
        (n, f) => n + codeLineCount(f, readFileSync(f, 'utf8')),
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
