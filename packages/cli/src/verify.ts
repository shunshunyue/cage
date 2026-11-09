/**
 * 应用验证编排，串联类型、依赖、lint、声明、生成一致性、托管区、预算与测试。
 * 每个门禁记录 .cage/verify.json 并在失败时停止；测试先生成临时配置和派生用例，再执行真实 Vitest。
 * 报告只代表本次已执行阶段，跳过用例另在测试报告及终端提示；本模块不执行浏览器验收或真实第三方联调。
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

/**
 * 生成通用性质用例并执行 Vitest，先删除旧报告避免读取历史成功结果。
 * @param cfg 应用与生成目录配置。
 * @param graph 当前本体。
 * @param only 可限定派生或项目用例，项目模式允许无测试。
 * @returns 进程和 JSON 报告共同确定的退出码；pending 会提示，但不单独使本函数失败。
 */
export async function testProject(
  cfg: CageConfig,
  graph: Ontology,
  only?: 'derived' | 'project',
): Promise<number> {
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
  if (code !== 0) return code;
  if (!existsSync(report)) throw new Error('[CAGE-TEST-001] 测试进程未输出结果报告，不能判定通过');
  const result = JSON.parse(readFileSync(report, 'utf8'));
  if (result.numPendingTests) console.log(`覆盖提示：${result.numPendingTests} 个用例跳过，请结合业务测试验收。`);
  return result.success ? 0 : 1;
}

/**
 * 依次执行门禁并写入当前阶段结果，首个失败后停止。
 * @param cfg 类型、依赖、源码和生成目录配置。
 * @param opts 可提供语义基线；skipTests 省略整个测试阶段。
 * @returns 0 表示已执行门禁通过，1 表示失败，工具启动或文件异常仍可抛出。
 * complete 当前描述是否省略整个测试阶段，具体 pending 仍需读取 test-results.json。
 */
export async function verify(
  cfg: CageConfig,
  opts: { base?: Ontology; skipTests?: boolean } = {},
): Promise<number> {
  const gates: { name: string; ok: boolean; findings?: Finding[] }[] = [];
  const record = (name: string, findings: Finding[] = [], code = 0) => {
    const ok = code === 0 && errorsOnly(findings).length === 0;
    gates.push({ name, ok, findings });
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (findings.length) console.log(formatFindings(findings));
    mkdirSync(abs(cfg, '.cage'), { recursive: true });
    writeFileSync(
      abs(cfg, '.cage/verify.json'),
      JSON.stringify({ ok: gates.every((g) => g.ok), complete: false, gates }, null, 2),
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
  if (!opts.skipTests && !record('派生与项目测试', [], await testProject(cfg, a.graph))) return 1;
  writeFileSync(
    abs(cfg, '.cage/verify.json'),
    JSON.stringify({ ok: true, complete: !opts.skipTests, gates }, null, 2),
  );
  console.log(opts.skipTests ? '静态门禁通过（未运行测试）' : '全部门禁通过');
  return 0;
}
