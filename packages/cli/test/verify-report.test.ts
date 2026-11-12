/**
 * 验证 verify 对测试通过、跳过、待实现、无用例及失败的报告边界。
 * 在临时项目内实际写入测试配置与验证报告，仅替换外部工具和声明分析，避免启动数据库。
 * 模拟的进程退出码与 JSON 报告可独立变化，用来确认旧成功报告或部分执行不会被描述成完整验证。
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type CageConfig } from '../src/config.js';
import { sync } from '../src/sync.js';
import { verify } from '../src/verify.js';
import { run } from '../src/process.js';

/** 本轮假进程的独立输入；不以预期 complete 值代替真实报告计算。 */
const runner = vi.hoisted(() => ({
  exitCode: 0,
  emitReport: true,
  report: { success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 },
}));

// 外部命令只在要求输出结果文件时写入本轮报告；其他静态工具统一成功，隔离待验证的证据边界。
vi.mock('../src/process.js', async () => {
  const { writeFileSync } = await import('node:fs');
  return {
    binPath: () => 'test-tool',
    run: vi.fn(async (_tool: string, args: string[]) => {
      const index = args.indexOf('--outputFile');
      if (index < 0) return 0;
      if (runner.emitReport) writeFileSync(args[index + 1], JSON.stringify(runner.report));
      return runner.exitCode;
    }),
  };
});
vi.mock('eslint', () => ({
  /** 本套件只验证测试摘要，lint 的真实规则由各规则测试覆盖。 */
  ESLint: class {
    /** 静态检查夹具始终成功，不引入额外报告项目。 */
    async lintFiles() { return []; }
  },
}));
vi.mock('../src/analyze.js', () => ({
  analyze: async () => ({
    graph: { version: 1, nodes: [], edges: [], unsafeCount: 0 },
    registry: {},
    source: { sites: [] },
    findings: [],
  }),
}));
vi.mock('../src/gen/index.js', () => ({ generate: () => ({ findings: [] }) }));

/** 只清理由本套件 mkdtemp 创建的目录，不触碰工作区或真实应用。 */
const temporary = mkdtempSync(join(tmpdir(), 'cage-verify-report-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  runner.exitCode = 0;
  runner.emitReport = true;
  runner.report = { success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

/** 创建独立项目并同步真实托管区；只省略与本套件无关的 TypeScript 和 lint 目录。 */
function project(): CageConfig {
  const cfg = { ...loadConfig(mkdtempSync(join(temporary, 'project-'))), typecheck: [], lint: [] };
  sync(cfg);
  return cfg;
}

/** 读取本轮 verify 的落盘交付，不以返回码推测完整性。 */
const reportOf = (cfg: CageConfig) => JSON.parse(readFileSync(join(cfg.root, '.cage/verify.json'), 'utf8'));

it('实际用例全部通过时记录完整门禁及用例计数', async () => {
  const cfg = project();
  expect(await verify(cfg)).toBe(0);
  expect(reportOf(cfg)).toMatchObject({ ok: true, complete: true, tests: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 } });
});

it.each([
  { label: '跳过', total: 2, passed: 1, skipped: 1, todo: 0 },
  { label: '待实现', total: 2, passed: 1, skipped: 0, todo: 1 },
  { label: '没有用例', total: 0, passed: 0, skipped: 0, todo: 0 },
])('$label 不改变无失败退出码，但保留不完整和真实数量', async ({ total, passed, skipped, todo }) => {
  const cfg = project();
  runner.report = { success: true, numTotalTests: total, numPassedTests: passed, numFailedTests: 0, numPendingTests: skipped, numTodoTests: todo };
  expect(await verify(cfg)).toBe(0);
  expect(reportOf(cfg)).toMatchObject({ ok: true, complete: false, tests: { total, passed, skipped, todo } });
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('验证不完整');
});

it('省略测试阶段不会读取上次的成功报告补造完整结果', async () => {
  const cfg = project();
  mkdirSync(join(cfg.root, '.cage'));
  writeFileSync(join(cfg.root, '.cage/test-results.json'), JSON.stringify(runner.report));
  expect(await verify(cfg, { skipTests: true })).toBe(0);
  expect(reportOf(cfg)).toMatchObject({ ok: true, complete: false });
  expect(reportOf(cfg).tests).toBeUndefined();
  expect(vi.mocked(run).mock.calls.some(([, args]) => args.includes('--outputFile'))).toBe(false);
});

it('进程失败时不使用成功 JSON 掩盖失败', async () => {
  const cfg = project();
  runner.exitCode = 1;
  expect(await verify(cfg)).toBe(1);
  expect(reportOf(cfg)).toMatchObject({ ok: false, complete: false });
});

it('进程退出零但报告失败时仍然拒绝通过', async () => {
  const cfg = project();
  runner.report = { ...runner.report, success: false, numPassedTests: 1, numFailedTests: 1 };
  expect(await verify(cfg)).toBe(1);
  expect(reportOf(cfg)).toMatchObject({ ok: false, complete: false, tests: { passed: 1, failed: 1 } });
});

it('本轮未产生报告时删除旧报告并拒绝判定通过', async () => {
  const cfg = project();
  mkdirSync(join(cfg.root, '.cage'));
  const previous = join(cfg.root, '.cage/test-results.json');
  writeFileSync(previous, JSON.stringify(runner.report));
  runner.emitReport = false;
  await expect(verify(cfg)).rejects.toThrow('CAGE-TEST-001');
  expect(existsSync(previous)).toBe(false);
  expect(reportOf(cfg).complete).toBe(false);
});
