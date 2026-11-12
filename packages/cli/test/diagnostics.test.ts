/**
 * 验证生成校验器、命名快照、能力签名和运行实例证据的诊断边界。
 * 真实 schema 比较与临时快照检查转换边界、独占保存和只读分析；注入运行响应检查授权解释与凭据脱敏。
 * 未提供实例证据必须保留 unknown，文件存在不能替代进程已加载证明。
 */
import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { jsonToZod, schemaDiagnostics, zodCodeOf } from '../src/gen/zod-code.js';
import { snapshotPath, saveSnapshot } from '../src/snapshots.js';
import { readOntology } from '../src/impact.js';
import { loadConfig } from '../src/config.js';
import { doctor } from '../src/doctor.js';
import { runtimeDiagnostic } from '../src/runtime-diagnostics.js';
import { publicCapabilities } from '../src/capabilities.js';
import { analyze } from '../src/analyze.js';
import { buildRegistry, event, reactionEach } from '@yss123/cage-kernel';
import { extract } from '../src/ontology.js';
import { buildOpenApi } from '../../http/src/openapi.js';
import * as domain from '../../testkit/test/fixtures/domain.js';

const directory = mkdtempSync(join(tmpdir(), 'cage-diagnostics-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/**
 * 用相同输入分别执行原始 Zod 与生成 Zod，比较接受性和解析输出，覆盖严格对象、倍数及默认值。
 */
it('generated schemas retain strict objects, multiples, defaults and parse output', () => {
  const source = z.object({ amount: z.number().multipleOf(5), mode: z.string().default('draft') }).strict();
  const generated = new Function('z', `return ${zodCodeOf(source)}`)(z) as z.ZodType;
  for (const input of [{ amount: 10 }, { amount: 11 }, { amount: 10, extra: true }, { amount: 10, mode: 'x' }]) {
    const before = source.safeParse(input), after = generated.safeParse(input);
    expect(after.success).toBe(before.success);
    if (before.success && after.success) expect(after.data).toEqual(before.data);
  }
  expect(jsonToZod({ type: 'object', properties: {}, additionalProperties: false }, {})).toContain('.strict()');
});

/**
 * 服务端 refine 无法序列化时，诊断必须指到数组元素的真实字段，不能只报告整个对象。
 */
it('reports the exact field containing a server-only refinement', () => {
  const schema = z.object({ rows: z.array(z.object({ value: z.string().refine(value => value === 'ok') })) });
  expect(schemaDiagnostics(schema)).toEqual([expect.objectContaining({ path: '$.rows[].value', reason: expect.stringContaining('refine') })]);
});

/**
 * 保留可表达的字符串边界、可选元组位置和 record key 规则，交叉对象解析结果也需一致。
 */
it('retains formatted string patterns, optional tuple positions and record keys', () => {
  const source = z.object({ code: z.string().startsWith('A').endsWith('Z'), pair: z.tuple([z.string(), z.number().optional()]), values: z.record(z.string().regex(/^[a-z]+$/), z.number()) });
  const generated = new Function('z', `return ${zodCodeOf(source)}`)(z) as z.ZodType;
  for (const input of [
    { code: 'ABZ', pair: ['one'], values: { ok: 1 } },
    { code: 'ABZ', pair: ['one', 2], values: { ok: 1 } },
    { code: 'ABX', pair: ['one'], values: {} },
    { code: 'ABZ', pair: ['one'], values: { BAD: 1 } },
  ]) expect(generated.safeParse(input).success).toBe(source.safeParse(input).success);
  const intersection = z.intersection(z.object({ one: z.string() }), z.object({ two: z.number() }));
  const generatedIntersection = new Function('z', `return ${zodCodeOf(intersection)}`)(z) as z.ZodType;
  const input = { one: 'one', two: 2, extra: true };
  expect(generatedIntersection.parse(input)).toEqual(intersection.parse(input));
});

/**
 * 无法表达的变换和正则标志只放宽客户端校验，并在 OpenAPI 标记服务端验证，不能误拒合法输入。
 */
it('server-only conversion and regex flags never make generated validation stricter', () => {
  const source = z.object({ code: z.string().regex(/^ok$/i), label: z.string().trim().max(2), count: z.number().catch(0) });
  const input = { code: 'OK', label: ' x ', count: 'fallback' };
  expect(source.safeParse(input).success).toBe(true);
  const generated = new Function('z', `return ${zodCodeOf(source)}`)(z) as z.ZodType;
  expect(generated.safeParse(input).success).toBe(true);
  expect(schemaDiagnostics(source).map(finding => finding.path)).toEqual(expect.arrayContaining(['$.code', '$.label', '$.count']));
  const registry = buildRegistry(domain);
  const spec = buildOpenApi({ registry } as Parameters<typeof buildOpenApi>[0], [{ method: 'POST', url: '/test', capability: 'Test.create', kind: 'command', input: source }]);
  const schema = ((spec.paths['/test'].post.requestBody as any).content['application/json'].schema);
  expect(schema.properties.code).toMatchObject({ 'x-cage-server-validation': true });
  expect(schema.properties.code.pattern).toBeUndefined();
  expect(schema.properties.label).toMatchObject({ 'x-cage-server-validation': true });
  expect(schema.properties.label.maxLength).toBeUndefined();
});

/**
 * 递归续接处可以明确放宽，但根层普通字段仍须校验；不存在的 schema 引用必须报错。
 */
it('recursive schemas report and safely relax only the recursive continuation', () => {
  const source = z.object({ name: z.string(), get children(): z.ZodArray<typeof source> { return z.array(source); } });
  expect(schemaDiagnostics(source)).toContainEqual(expect.objectContaining({ path: '$.children[]', reason: expect.stringContaining('递归') }));
  const code = zodCodeOf(source);
  expect(code).toContain('CAGE-GEN-003');
  const generated = new Function('z', `return ${code}`)(z) as z.ZodType;
  expect(generated.safeParse({ name: 'root', children: [{ name: 'child', children: [] }] }).success).toBe(true);
  expect(generated.safeParse({ name: 1, children: [] }).success).toBe(false);
  expect(() => jsonToZod({ $ref: '#/$defs/missing' }, {})).toThrow('CAGE-GEN-003');
});

/**
 * impact 接受命名快照信封的 graph 内容；快照名不得包含目录逃逸路径。
 */
it('named snapshots are valid impact inputs and reject escaping names', () => {
  const cfg = loadConfig(directory);
  expect(() => snapshotPath(cfg, '../old')).toThrow('CAGE-IMPACT-002');
  const file = join(directory, 'saved.json');
  const graph = { version: 1, nodes: [], edges: [], unsafeCount: 0 };
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: 'before', graph }));
  expect(readOntology(file)).toEqual(graph);
  expect(readFileSync(file, 'utf8')).toContain('before');
});

/**
 * 保存一次基线后拒绝同名覆盖，再执行会更新当前本体的分析，证明独立基线字节保持原样。
 */
it('saving a baseline is exclusive and later analysis cannot change it', async () => {
  const root = join(directory, 'snapshots');
  mkdirSync(join(root, 'packages/domain/src'), { recursive: true });
  writeFileSync(join(root, 'packages/domain/src/index.ts'), `export * from ${JSON.stringify(import.meta.resolve('@yss123/cage-admin/domain'))};`);
  const cfg = loadConfig(root);
  await saveSnapshot(cfg, 'before');
  const file = snapshotPath(cfg, 'before');
  const before = readFileSync(file, 'utf8');
  await expect(saveSnapshot(cfg, 'before')).rejects.toThrow('已存在');
  await analyze(cfg, { write: true });
  expect(readFileSync(file, 'utf8')).toBe(before);
});

/**
 * 批量反应的 maxItems/orderBy 与事务/顺序是执行边界，抽取不能为了简化图谱而丢失它们。
 */
it('collection metadata remains available to graph and AI context consumers', () => {
  const Batch = event('DiagnosticBatch', {});
  const batchReaction = reactionEach(Batch, { command: domain.acquireLock, tx: 'same', order: 2, maxItems: 20, orderBy: 'key', items: () => [{ key: 'one' }], map: () => null });
  const registry = buildRegistry({ ...domain, Batch, batchReaction });
  const graph = extract(registry);
  expect(graph.nodes.find(node => node.id === 'batchReaction')?.attrs).toMatchObject({ tx: 'same', order: 2, collection: { maxItems: 20, orderBy: 'key' } });
});

/**
 * 离线空项目没有迁移、授权或进程证据，doctor 必须标 unknown 且 complete=false。
 */
it('doctor does not invent runtime success or write generated artifacts', async () => {
  const project = join(directory, 'project');
  mkdirSync(join(project, 'packages/domain/src'), { recursive: true });
  writeFileSync(join(project, 'packages/domain/src/index.ts'), 'export {};');
  const cfg = loadConfig(project);
  const report = await doctor(cfg);
  expect(report.checks.filter(check => ['migration', 'authorization', 'api', 'worker'].includes(check.id)).every(check => check.status === 'unknown')).toBe(true);
  expect(report.complete).toBe(false);
  expect(report.limitations.join(' ')).toContain('不执行');
});

/**
 * 授权解释 POST 先获取 CSRF；新 cookie 与原 session 合并发送，但报告不得返回 token。
 */
it('runtime authorization explanation merges CSRF cookies without returning credentials', async () => {
  const cookieFile = join(directory, 'diagnostic-cookie.txt');
  writeFileSync(cookieFile, 'session=synthetic-session');
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await runtimeDiagnostic(loadConfig(directory), { runtimeUrl: 'http://127.0.0.1:3000', cookieFile, fetch: (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/csrf')) return new Response(JSON.stringify({ token: 'synthetic-csrf' }), { headers: { 'set-cookie': 'csrf-cookie=synthetic-cookie; Path=/' } });
    return new Response(JSON.stringify({ allowed: false, checks: [{ kind: 'capability', allowed: false }] }));
  }) as typeof fetch }, '/api/sys/diagnostics/authorization', { body: { command: 'Order.submit', input: { id: 'synthetic-id' } } });
  expect(calls).toHaveLength(2);
  expect(calls[1].init?.headers).toMatchObject({ cookie: 'session=synthetic-session; csrf-cookie=synthetic-cookie', 'x-csrf-token': 'synthetic-csrf' });
  expect(result.data).toMatchObject({ allowed: false });
  expect(JSON.stringify(result)).not.toContain('synthetic-csrf');
});

/**
 * 带凭据、查询、锚点或非 HTTP 地址，以及改变实例 origin 的路径，必须在调用 fetch 前拒绝。
 */
it('diagnostic requests reject credentials in addresses and cannot change the configured origin', async () => {
  const cfg = loadConfig(directory);
  const unused = (() => { throw new Error('invalid request reached network'); }) as typeof fetch;
  for (const runtimeUrl of ['http://user:password@localhost', 'http://localhost?token=secret', 'http://localhost#secret', 'file:///tmp'])
    await expect(runtimeDiagnostic(cfg, { runtimeUrl, fetch: unused }, '/api/sys/diagnostics')).rejects.toThrow('CAGE-DIAG-001');
  await expect(runtimeDiagnostic(cfg, { runtimeUrl: 'http://localhost', fetch: unused }, 'https://elsewhere.invalid')).rejects.toThrow('CAGE-DIAG-001');
});

/**
 * 按中文“本人”召回已安装声明中的 ownerField 签名，以实际公开 API 证明能力，避免仅凭词表臆造接口。
 */
it('public discovery finds the installed owner signature instead of claiming the feature is absent', () => {
  const cfg = loadConfig(fileURLToPath(new URL('../../../examples/purchase-admin/', import.meta.url)));
  const report = publicCapabilities(cfg, '本人');
  expect(report.capabilities).toContainEqual(expect.objectContaining({ name: 'scope', public: true, signatures: [expect.stringContaining('ownerField')] }));
});

/** 中文命名需求必须定位现有 states 签名和 labels 用法，不能返回一个虚构的本体命名接口。 */
it('状态名称需求能找到真实states签名与本体建模指南', () => {
  const cfg = loadConfig(fileURLToPath(new URL('../../../examples/purchase-admin/', import.meta.url)));
  const report = publicCapabilities(cfg, '状态名称');
  const capability = report.capabilities.find(item => item.key === '@yss123/cage-kernel#states');
  expect(capability).toMatchObject({ public: true, guide: 'docs/development/guides/ontology-modeling.md' });
  expect(capability!.signatures).toContainEqual(expect.stringContaining('StatesDef'));
  expect(capability!.example?.code).toContain("labels: { active: '使用中', archived: '已归档' }");
  expect(capability!.source.file).toMatch(/\.d\.ts$/);
});

/** 依据当前安装的公开声明核对 AND 能力发现，关键词不能把只有会签的旧 API 描述成并行网关。 */
it('并行审批需求定位真实parallel与branch签名并说明结构化AND边界', () => {
  const cfg = loadConfig(fileURLToPath(new URL('../../../examples/purchase-admin/', import.meta.url)));
  const report = publicCapabilities(cfg, '并行');
  for (const name of ['parallel', 'branch']) {
    const item = report.capabilities.find(capability => capability.key === `@yss123/cage-approval#${name}`);
    expect(item).toMatchObject({ public: true, guide: 'docs/development/guides/approvals.md' });
    expect(item?.signatures.length).toBeGreaterThan(0);
  }
  expect(report.capabilities.find(item => item.key === '@yss123/cage-approval#parallel')?.limitations)
    .toContainEqual(expect.stringContaining('全部活动分支完成'));
});

it.each([
  ['AI审批', ['ai', 'step', 'AiStepOptions']],
  ['AI 审批', ['step', 'AiStepOptions']],
  ['业务助理', ['ai', 'useAssistant']],
  ['页面上下文', ['AiPageContext', 'useAiPageContext']],
  ['随页助理', ['AiPageContext', 'useAssistant']],
  ['模型管理', ['managedModel']],
  ['Responses', ['responsesModel', 'managedModel']],
  ['性格', ['useAssistant', 'AiPersonality']],
  ['上下文预算', ['ai', 'AiContextOptions']],
])('需求“%s”能发现已安装的 AI 公开 API 并进入本地指南', (query, names) => {
  const cfg = loadConfig(fileURLToPath(new URL('../../../examples/purchase-admin/', import.meta.url)));
  const report = publicCapabilities(cfg, query);
  for (const name of names) {
    const capability = report.capabilities.find(item => item.name === name);
    expect(capability, `${query}: ${name}`).toMatchObject({ public: true, guide: 'docs/development/guides/intelligence.md' });
    expect(capability!.signatures.length).toBeGreaterThan(0);
    expect(capability!.source.file).toMatch(/\.d\.ts$/);
  }
  // 词表只能召回真实导出，不能给应用一个并不存在的新原语。
  expect(report.capabilities.some(item => item.name === 'aiStep')).toBe(false);
  if (query === 'AI审批') {
    const step = report.capabilities.find(item => item.name === 'step')!;
    expect(step.package).toBe('@yss123/cage-approval');
    expect(step.signatures).toContainEqual(expect.stringContaining('AiStepOptions'));
    expect(report.capabilities.some(item => item.key === '@yss123/cage-kernel#step')).toBe(false);
  }
});
