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
