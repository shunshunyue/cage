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

it('reports the exact field containing a server-only refinement', () => {
  const schema = z.object({ rows: z.array(z.object({ value: z.string().refine(value => value === 'ok') })) });
  expect(schemaDiagnostics(schema)).toEqual([expect.objectContaining({ path: '$.rows[].value', reason: expect.stringContaining('refine') })]);
});

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

it('named snapshots are valid impact inputs and reject escaping names', () => {
  const cfg = loadConfig(directory);
  expect(() => snapshotPath(cfg, '../old')).toThrow('CAGE-IMPACT-002');
  const file = join(directory, 'saved.json');
  const graph = { version: 1, nodes: [], edges: [], unsafeCount: 0 };
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: 'before', graph }));
  expect(readOntology(file)).toEqual(graph);
  expect(readFileSync(file, 'utf8')).toContain('before');
});

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

it('collection metadata remains available to graph and AI context consumers', () => {
  const Batch = event('DiagnosticBatch', {});
  const batchReaction = reactionEach(Batch, { command: domain.acquireLock, tx: 'same', order: 2, maxItems: 20, orderBy: 'key', items: () => [{ key: 'one' }], map: () => null });
  const registry = buildRegistry({ ...domain, Batch, batchReaction });
  const graph = extract(registry);
  expect(graph.nodes.find(node => node.id === 'batchReaction')?.attrs).toMatchObject({ tx: 'same', order: 2, collection: { maxItems: 20, orderBy: 'key' } });
});

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

it('diagnostic requests reject credentials in addresses and cannot change the configured origin', async () => {
  const cfg = loadConfig(directory);
  const unused = (() => { throw new Error('invalid request reached network'); }) as typeof fetch;
  for (const runtimeUrl of ['http://user:password@localhost', 'http://localhost?token=secret', 'http://localhost#secret', 'file:///tmp'])
    await expect(runtimeDiagnostic(cfg, { runtimeUrl, fetch: unused }, '/api/sys/diagnostics')).rejects.toThrow('CAGE-DIAG-001');
  await expect(runtimeDiagnostic(cfg, { runtimeUrl: 'http://localhost', fetch: unused }, 'https://elsewhere.invalid')).rejects.toThrow('CAGE-DIAG-001');
});

it('public discovery finds the installed owner signature instead of claiming the feature is absent', () => {
  const cfg = loadConfig(fileURLToPath(new URL('../../../examples/purchase-admin/', import.meta.url)));
  const report = publicCapabilities(cfg, '本人');
  expect(report.capabilities).toContainEqual(expect.objectContaining({ name: 'scope', public: true, signatures: [expect.stringContaining('ownerField')] }));
});
