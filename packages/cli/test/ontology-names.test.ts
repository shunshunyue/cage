/**
 * 验证本体命名从真实声明进入诊断，再由 CLI 决定警告或阻止生成的完整链路。
 * 注册表夹具覆盖成员定位、声明文案和配置覆盖；临时应用覆盖 check/gen 退出码及图谱可修复性。
 * 全部操作限于内存和测试临时目录，不读业务数据库，也不把命名通过当作业务关系正确。
 */
import { afterAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, buildRegistry, command, event, job, query, reaction, scope, states, text } from '@yss123/cage-kernel';
import { checkOntologyNames } from '../src/ontology-names.js';
import { loadConfig, type CageConfig } from '../src/config.js';
import { errorsOnly, formatFindings } from '../src/findings.js';
import { graphPresentation } from '../src/graph-presentation.js';
import { extract } from '../src/ontology.js';
import { analyze } from '../src/analyze.js';
import { main } from '../src/main.js';
import { collectGraph } from '../dist/graph.js';
import type { DeclSite } from '../src/static-check.js';

const directory = mkdtempSync(join(tmpdir(), 'cage-ontology-names-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/**
 * 构造同一便笺模型的缺名与完整版本；依赖对象无本地位置，反应则没有通用描述选项。
 * @param named 是否在真实 API 中填写名称；缺名版只给 active 标签，便于核对部分状态遗漏。
 * @returns 注册表与含项目位置的本体，不执行任何 handler、任务或反应。
 */
function declarations(named = false) {
  const Note = aggregate('NamingNote', {
    description: named ? '部门便笺' : undefined,
    fields: { title: named ? text(120).describe('便笺标题') : text(120) },
    states: states('active', 'archived', { terminal: ['archived'], labels: named ? { active: '使用中', archived: 'Archived' } : { active: '使用中' } }),
    scope: scope.none(),
  });
  const NoteSaved = event('NamingNoteSaved', {}, { description: named ? '便笺已保存' : undefined });
  const create = command(Note, { name: 'create', from: 'new', to: 'active', description: named ? '新建便笺' : undefined, handler: o => o });
  const archive = command(Note, { name: 'archive', from: 'active', to: 'archived', description: named ? '归档便笺' : undefined, handler: o => o });
  const recentNotes = query('recentNamingNotes', { reads: [Note], sql: 'select id from safe.naming_note limit 10', description: named ? '最近便笺' : undefined });
  const archiveJob = job('archiveNamingNotes', { cron: '0 0 * * *', calls: [archive], description: named ? '定时归档便笺' : undefined, run: async () => {} });
  const archiveOnSaved = reaction(NoteSaved, { command: archive, map: () => null });
  const LibraryObject = aggregate('LibraryObject', { fields: { name: text() }, scope: scope.none() });
  const registry = buildRegistry({ Note, NoteSaved, create, archive, recentNotes, archiveJob, archiveOnSaved, LibraryObject });
  const sites: DeclSite[] = [
    ['Note', 'aggregate'], ['NoteSaved', 'event'], ['create', 'command'], ['archive', 'command'],
    ['recentNotes', 'query'], ['archiveJob', 'job'], ['archiveOnSaved', 'reaction'],
  ].map(([exportName, primitive], index) => ({ exportName, primitive, file: 'packages/domain/src/note.ts', line: 20 + index, text: '', domainCodes: [] }));
  return { registry, graph: extract(registry, sites) };
}

/** 只在图谱能拿到结构化名称时放行；成员回到所属聚合，不能制造精确字段行号或漏查部分状态。 */
it('reports missing names on local declarations and identifies the aggregate location for members', () => {
  const cfg = loadConfig(directory);
  const { registry, graph } = declarations();
  const before = JSON.stringify(graph);
  const findings = checkOntologyNames(cfg, graph, graphPresentation(cfg, registry));
  expect(findings).toHaveLength(8);
  for (const key of [
    'aggregate:NamingNote', 'field:NamingNote.title', 'state:NamingNote.archived',
    'command:NamingNote.create', 'command:NamingNote.archive', 'event:NamingNoteSaved',
    'query:recentNamingNotes', 'job:archiveNamingNotes',
  ]) expect(findings).toContainEqual(expect.objectContaining({ code: 'CAGE-ONTOLOGY-001', severity: 'warning', reason: expect.stringContaining(key) }));
  for (const key of ['field:NamingNote.title', 'state:NamingNote.archived']) {
    expect(findings.find(f => f.reason.startsWith(key))).toMatchObject({ at: 'packages/domain/src/note.ts:20', fix: expect.stringContaining('普通注释和页面文案不会被抽取') });
  }
  expect(errorsOnly(findings)).toHaveLength(0);
  expect(formatFindings(findings)).toContain('[CAGE-ONTOLOGY-001] 警告');
  expect(JSON.stringify(graph)).toBe(before);
});

/** 英文业务名称合法；不检查无源码位置的依赖，也不强迫反应使用不存在的 description API。 */
it('accepts names from the supported APIs without imposing a language or naming unsupported nodes', () => {
  const cfg = loadConfig(directory);
  const { registry, graph } = declarations(true);
  expect(checkOntologyNames(cfg, graph, graphPresentation(cfg, registry))).toEqual([]);
});

/** 显示覆盖与图谱优先级一致；空白覆盖仍应报缺失，required 只改变门禁级别，不修改图。 */
it('honors display overrides and rejects blank names in required mode', () => {
  const cfg: CageConfig = { ...loadConfig(directory), graph: { naming: 'required', labels: {
    'aggregate:NamingNote': '便笺', 'field:NamingNote.title': '标题', 'state:NamingNote.archived': '已归档',
    'command:NamingNote.create': '新建', 'command:NamingNote.archive': '归档', 'event:NamingNoteSaved': '已保存',
    'query:recentNamingNotes': '最近便笺', 'job:archiveNamingNotes': '定时归档',
  } } };
  const { registry, graph } = declarations();
  expect(checkOntologyNames(cfg, graph, graphPresentation(cfg, registry))).toEqual([]);
  cfg.graph!.labels!['state:NamingNote.active'] = '   ';
  const findings = checkOntologyNames(cfg, graph, graphPresentation(cfg, registry));
  expect(findings).toEqual([expect.objectContaining({ severity: 'error', reason: expect.stringContaining('state:NamingNote.active') })]);
  expect(errorsOnly(findings)).toHaveLength(1);
  expect(formatFindings(findings)).toContain('[CAGE-ONTOLOGY-001] 错误');
});

/**
 * 写入可由真实 analyze/CLI 加载的最小应用，各测试使用独立入口避免 ESM 缓存掩盖遗漏。
 * @param name 测试子目录名。
 * @param naming 缺省兼容警告，required 作为门禁。
 * @param named 是否填写结构化名称；注释始终写中文，用来证明注释不能代替 labels。
 * @returns 仅包含领域入口与配置的临时应用根目录。
 */
function application(name: string, naming?: 'required', named = false): string {
  const root = join(directory, name);
  mkdirSync(join(root, 'packages/domain/src'), { recursive: true });
  // 与真实脚手架保持 ESM 边界，独立抽取进程才能按文件 URL 加载相同的框架声明实例。
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: `ontology-names-${name}`, type: 'module' }));
  writeFileSync(join(root, 'cage.config.json'), JSON.stringify({ graph: { naming } }));
  writeFileSync(join(root, 'packages/domain/src/index.ts'), `
import { aggregate, command, scope, states, text } from ${JSON.stringify(import.meta.resolve('@yss123/cage-kernel'))};
export * from ${JSON.stringify(import.meta.resolve('@yss123/cage-admin/domain'))};
/** 便笺：active 表示使用中，archived 表示已归档；普通注释不应被当成结构化标签。 */
export const Note = aggregate('NamingNote', {
  ${named ? "description: '部门便笺'," : ''}
  fields: { title: text(120)${named ? ".describe('便笺标题')" : ''} },
  states: states('active', 'archived', { terminal: ['archived']${named ? ", labels: { active: '使用中', archived: '已归档' }" : ''} }),
  scope: scope.none(),
});
/** 创建 active 便笺，名称仍须在命令选项填写。 */
export const create = command(Note, { name: 'create', from: 'new', to: 'active', ${named ? "description: '新建便笺'," : ''} handler: o => o });
/** 归档后不再恢复，供可达性规则验证真实终点。 */
export const archive = command(Note, { name: 'archive', from: 'active', to: 'archived', ${named ? "description: '归档便笺'," : ''} handler: o => o });
`);
  return root;
}

/** 以真实退出码和写盘结果证明兼容警告不阻断旧项目，严格模式在生成前失败。 */
it('integrates warnings and required naming into analyze, check and generation', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const warningRoot = application('warning');
    const result = await analyze(loadConfig(warningRoot));
    expect(result.findings, formatFindings(result.findings)).toHaveLength(6);
    expect(result.findings.every(f => f.code === 'CAGE-ONTOLOGY-001' && f.severity === 'warning')).toBe(true);
    expect(await main(['check', '--root', warningRoot])).toBe(0);
    expect(await main(['gen', '--root', warningRoot])).toBe(0);
    expect(existsSync(join(warningRoot, 'packages/contracts/src/index.ts'))).toBe(true);

    const requiredRoot = application('required', 'required');
    expect(await main(['check', '--root', requiredRoot])).toBe(1);
    expect(await main(['gen', '--root', requiredRoot])).toBe(1);
    expect(existsSync(join(requiredRoot, 'packages/contracts/src/index.ts'))).toBe(false);
    expect(output.mock.calls.flat().join('\n')).toContain('state:NamingNote.archived');

    const namedRoot = application('named', 'required', true);
    expect((await analyze(loadConfig(namedRoot))).findings).toEqual([]);
    expect(await main(['gen', '--root', namedRoot])).toBe(0);
    expect(existsSync(join(namedRoot, 'packages/contracts/src/index.ts'))).toBe(true);
  } finally { output.mockRestore(); }
});

/** 命名门禁失败后仍交付图和错误，开发者可继续用图谱定位；独立进程避免读到缓存声明。 */
it('keeps a graph snapshot available while required names are missing', async () => {
  const root = application('snapshot', 'required');
  const snapshot = await collectGraph(root);
  expect(snapshot.graph.nodes).toContainEqual(expect.objectContaining({ kind: 'state', id: 'NamingNote.archived' }));
  expect(snapshot.findings).toContainEqual(expect.objectContaining({ code: 'CAGE-ONTOLOGY-001', severity: 'error', reason: expect.stringContaining('state:NamingNote.archived') }));
});
