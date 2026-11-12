/**
 * 应用验证编排，串联类型、依赖、lint、声明、生成一致性、托管区、预算与测试。
 * 每个门禁记录 .cage/verify.json 并在失败时停止；测试先生成临时配置和派生用例，再执行真实 Vitest。
 * 报告只代表本次已执行阶段，测试数量同步进入验证摘要，skip/todo 或无用例会保留不完整标记。
 * 本模块不执行浏览器验收或真实第三方联调，门禁通过不能代替业务完成证据。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ESLint } from 'eslint';
import cageLint from '@yss123/cage-lint';
import { abs, type CageConfig } from './config.js';
import { analyze } from './analyze.js';
import { errorsOnly, formatFindings, type Finding } from './findings.js';
import { generate } from './gen/index.js';
import { deriveTests, vitestConfig, writeDerived } from './derive.js';
import { binPath, run } from './process.js';
import { budget } from './budget.js';
import { sync } from './sync.js';
import type { Ontology } from './ontology.js';

/** 本次 Vitest 报告的用例计数；用于区分未失败与全部用例已实际执行，不推断业务覆盖率。 */
interface TestSummary {
  /** 报告中的用例总数，包括跳过与待实现项；零表示没有用例证据。 */
  total: number;
  /** 实际执行并通过的用例数。 */
  passed: number;
  /** 执行失败的用例数；进程退出和 success 字段仍单独判定失败。 */
  failed: number;
  /** Vitest numPendingTests，包括 skip 或未运行项，不计入通过。 */
  skipped: number;
  /** Vitest numTodoTests，保留待实现数量，不计入通过。 */
  todo: number;
}

/**
 * 为 test 和 verify 执行同一轮测试，删除旧报告后生成并运行真实 Vitest。
 * @param cfg 应用与生成目录配置。
 * @param graph 当前本体。
 * @param only 可限定派生或项目用例，项目模式允许无测试。
 * @returns 进程或报告失败返回非零；正常报告附本次计数，skip/todo 不单独改变退出码。
 * @throws 进程成功但没有结果文件时拒绝判定通过；文件或工具错误继续传播。
 */
async function executeProjectTests(
  cfg: CageConfig,
  graph: Ontology,
  only?: 'derived' | 'project',
): Promise<{ code: number; summary?: TestSummary }> {
  const derived = deriveTests(cfg, graph);
  writeDerived(cfg, derived.files);
  mkdirSync(abs(cfg, '.cage'), { recursive: true });
  const config = abs(cfg, '.cage/vitest.config.mts');
  writeFileSync(config, vitestConfig(cfg, only));
  console.log(`派生测试：${derived.tests.length} 个`);
  // 保存机器可读报告，门禁同时检查测试结果和进程退出码。
  // 报告先删除，避免异常退出时误读上一次成功结果；跳过用例会单独列出。
  const report = abs(cfg, '.cage/test-results.json');
  if (existsSync(report)) unlinkSync(report);
  const code = await run(
    binPath('vitest'),
    ['run', '--config', config, '--reporter=default', '--reporter=json', '--outputFile', report, ...(only === 'project' ? ['--passWithNoTests'] : [])],
    cfg.root,
  );
  if (code !== 0) return { code };
  if (!existsSync(report)) throw new Error('[CAGE-TEST-001] 测试进程未输出结果报告，不能判定通过');
  const result = JSON.parse(readFileSync(report, 'utf8'));
  const summary: TestSummary = {
    total: result.numTotalTests,
    passed: result.numPassedTests,
    failed: result.numFailedTests,
    skipped: result.numPendingTests,
    todo: result.numTodoTests,
  };
  console.log(`测试结果：通过 ${summary.passed}，失败 ${summary.failed}，跳过/未运行 ${summary.skipped}，待实现 ${summary.todo}，共 ${summary.total} 个用例。`);
  if (summary.skipped || summary.todo || !summary.total)
    console.log('覆盖提示：存在跳过、待实现或无用例的情况，请补足相应业务验证；未失败不等于全部已验证。');
  return { code: result.success ? 0 : 1, summary };
}

/**
 * 生成通用性质用例并运行派生/项目测试，供 CLI 及程序调用保持原有数字退出码。
 * @param cfg 应用与生成目录配置，写入 generated/tests 和 .cage 下本轮配置、结果。
 * @param graph 已通过声明分析的当前本体。
 * @param only 可限定派生或项目用例；项目模式允许无测试，但会提示证据缺口。
 * @returns 0 表示进程和报告未失败，skip/todo 仍需查阅摘要；缺报告或工具错误抛出。
 */
export async function testProject(cfg: CageConfig, graph: Ontology, only?: 'derived' | 'project'): Promise<number> {
  return (await executeProjectTests(cfg, graph, only)).code;
}

/**
 * 依次执行门禁并写入当前阶段结果，首个失败后停止。
 * @param cfg 类型、依赖、源码和生成目录配置。
 * @param opts 可提供语义基线；skipTests 省略整个测试阶段。
 * @returns 0 表示已执行门禁通过，1 表示失败，工具启动或文件异常仍可抛出。
 * complete 要求未省略阶段、存在用例且本次所有用例通过，无 skip/todo；它不表示业务或浏览器验收完成。
 */
export async function verify(
  cfg: CageConfig,
  opts: { base?: Ontology; skipTests?: boolean } = {},
): Promise<number> {
  const gates: { name: string; ok: boolean; findings?: Finding[] }[] = [];
  // 仅保存这轮进程返回的计数；静态验证不会读取上次测试报告补造成功。
  let tests: TestSummary | undefined;
  const record = (name: string, findings: Finding[] = [], code = 0) => {
    const ok = code === 0 && errorsOnly(findings).length === 0;
    gates.push({ name, ok, findings });
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (findings.length) console.log(formatFindings(findings));
    mkdirSync(abs(cfg, '.cage'), { recursive: true });
    writeFileSync(
      abs(cfg, '.cage/verify.json'),
      JSON.stringify({ ok: gates.every((g) => g.ok), complete: false, gates, tests }, null, 2),
    );
    return ok;
  };
  for (const dir of cfg.typecheck)
    if (
      !record(
        `typecheck ${dir}`,
        [],
        await run(binPath('typescript', 'tsc'), ['--noEmit', '-p', abs(cfg, dir)], cfg.root),
      )
    )
      return 1;
  const req = createRequire(import.meta.url);
  if (
    !record(
      '依赖规则',
      [],
      await run(
        binPath('dependency-cruiser', 'depcruise'),
        [
          '--config',
          req.resolve('@yss123/cage-lint/dependency-cruiser.cjs'),
          '--output-type',
          'err-long',
          ...cfg.lint,
        ],
        cfg.root,
      ),
    )
  )
    return 1;
  const eslint = new ESLint({
    cwd: cfg.root,
    overrideConfigFile: true,
    overrideConfig: cageLint.configs.recommended,
  });
  const lint = await eslint.lintFiles(cfg.lint.map((p) => `${p}/**/*.{ts,tsx,js,mjs}`));
  const lintFindings = lint.flatMap((f) =>
    f.messages.map((m): Finding => ({
      code: /\[(CAGE-[\w-]+)\]/.exec(m.message)?.[1] ?? 'CAGE-LINT-001',
      at: `${f.filePath}:${m.line}`,
      reason: m.message,
      severity: m.severity === 1 ? 'warning' : 'error',
    })),
  );
  if (!record('代码规则', lintFindings)) return 1;
  const a = await analyze(cfg, { base: opts.base });
  if (!record('声明与图规则', a.findings) || !a.graph || !a.registry) return 1;
  if (!record('生成物一致性', generate(cfg, a.registry, a.graph, a.source.sites, { check: true }).findings))
    return 1;
  if (!record('托管区一致性', sync(cfg, true))) return 1;
  if (!record('预算', budget(cfg, a.graph, opts.base).findings)) return 1;
  if (!opts.skipTests) {
    const result = await executeProjectTests(cfg, a.graph);
    tests = result.summary;
    if (!record('派生与项目测试', [], result.code)) return 1;
  }
  const complete = !opts.skipTests && !!tests && tests.total > 0 && tests.passed === tests.total && tests.skipped === 0 && tests.todo === 0;
  writeFileSync(
    abs(cfg, '.cage/verify.json'),
    JSON.stringify({ ok: true, complete, gates, tests }, null, 2),
  );
  console.log(opts.skipTests
    ? '静态门禁通过（未运行测试，验证不完整）'
    : complete
      ? '已配置门禁通过（业务与浏览器验收另行确认）'
      : '已执行门禁通过（测试含跳过、待实现或无用例，验证不完整）');
  return 0;
}
