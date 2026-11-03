// 验证 AI 真正依赖的行为：中文入口能找到完整链路，证据可追溯，歧义/截断不隐藏。
// 不启动数据库；这里检查开发工具输出，不重复运行运行时业务测试。
import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRegistry } from '@yss123/cage-kernel';
import * as domain from '../../testkit/test/fixtures/domain.js';
import { loadConfig } from '../src/config.js';
import { extract } from '../src/ontology.js';
import { graphPresentation } from '../src/graph-presentation.js';
import { searchGraph, inspectGraph, findGraphPath } from '../src/graph-query.js';
import { buildContext, formatContext } from '../src/context.js';
import { impact } from '../src/impact.js';
import type { GraphSnapshot } from '../src/graph-snapshot.js';

const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cage-context-test-')));
afterAll(() => {
  const target = resolve(temporary);
  if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('临时目录不在预期范围内');
  rmSync(target, { recursive: true, force: true });
});

const cfg = loadConfig(temporary);
cfg.graph = {
  labels: {
    'aggregate:PurchaseOrder': '采购单',
    'command:PurchaseOrder.cancel': '取消采购单',
    'event:OrderCancelled': '采购单已取消',
    'reaction:releaseOnCancel': '取消后释放库存锁',
  },
};
const registry = buildRegistry(domain);
const sites = [
  ['PurchaseOrder', 'aggregate', 'modules/purchase/order.ts', 5],
  ['cancel', 'command', 'modules/purchase/order.ts', 90],
  ['releaseOnCancel', 'reaction', 'workflows/purchase-inventory.ts', 20],
  ['poApproval', 'approval', 'modules/purchase/approval.ts', 10],
].map(([exportName, primitive, file, line]) => ({
  exportName: String(exportName),
  primitive: String(primitive),
  file: `packages/domain/src/${file}`,
  line: Number(line),
  text: '',
  domainCodes: [],
}));
const snapshot: GraphSnapshot = {
  project: 'purchase-test',
  domain: cfg.domain,
  generatedAt: '2026-10-31T00:00:00.000Z',
  graph: extract(registry, sites),
  findings: [],
  presentation: graphPresentation(cfg, registry),
};

it('中文需求按业务词匹配，返回命中理由；显示文案不改本体哈希', () => {
  const before = JSON.stringify(snapshot.graph);
  const report = searchGraph(snapshot, '修改采购单取消逻辑', { limit: 5, kind: 'command' });
  expect(report.hits[0].key).toBe('command:PurchaseOrder.cancel');
  expect(report.hits[0].matches).toContainEqual(
    expect.objectContaining({ field: 'label', terms: ['采购', '购单', '取消'] }),
  );
  expect(report.hits[0].source).toMatchObject({
    file: 'packages/domain/src/modules/purchase/order.ts',
    line: 90,
  });
  expect(searchGraph(snapshot, 'zzNoSuchBusinesszz').status).toBe('not-found');
  expect(JSON.stringify(snapshot.graph)).toBe(before);
});

it('精确节点歧义返回候选，字段只声称定位到所属聚合', () => {
  const input = structuredClone(snapshot);
  input.graph.nodes.push({ kind: 'state', id: 'PurchaseOrder.cancel', hash: '', attrs: {} });
  const ambiguous = inspectGraph(input, 'PurchaseOrder.cancel');
  expect(ambiguous.status).toBe('ambiguous');
  expect(ambiguous.node).toBeNull();
  expect(ambiguous.resolution.candidates.map((hit) => hit.key)).toEqual(
    expect.arrayContaining(['command:PurchaseOrder.cancel', 'state:PurchaseOrder.cancel']),
  );
  expect(inspectGraph(input, 'command:PurchaseOrder.cancel').node?.kind).toBe('command');
  expect(inspectGraph(snapshot, 'field:PurchaseOrder.amount').node?.source).toMatchObject({
    precision: 'aggregate',
    line: 5,
  });
});

it('取消链连接释放命令和取消审批；逆向探索保留原始方向，不经归属虚线短路', () => {
  const path = findGraphPath(snapshot, 'command:PurchaseOrder.cancel', 'command:InventoryLock.release');
  expect(path.status).toBe('ok');
  expect(path.nodes.map((node) => node.key)).toEqual([
    'command:PurchaseOrder.cancel',
    'event:OrderCancelled',
    'reaction:releaseOnCancel',
    'command:InventoryLock.release',
  ]);
  expect(
    findGraphPath(snapshot, 'command:PurchaseOrder.cancel', 'command:InventoryLock.release', { depth: 2 })
      .status,
  ).toBe('not-found-within-depth');
  const reversed = findGraphPath(snapshot, 'command:InventoryLock.release', 'command:PurchaseOrder.cancel', {
    direction: 'both',
  });
  expect(reversed.steps.every((step) => step.traversal === 'reverse')).toBe(true);
  expect(reversed.steps[0].relation.to).toBe('command:InventoryLock.release');
  expect(reversed.steps.some((step) => step.relation.kind === 'ownership')).toBe(false);
  const approval = findGraphPath(snapshot, 'event:OrderCancelled', 'approval:poApproval');
  expect(approval.steps[0].relation).toMatchObject({
    kind: 'cancels',
    label: '取消审批',
    evidence: {
      basis: 'declared',
      entries: ['poApproval.cancelOn 包含 OrderCancelled'],
      source: { line: 10 },
    },
  });
  const changed = structuredClone(snapshot.graph);
  changed.nodes.find((node) => node.id === 'OrderCancelled')!.hash = 'changed';
  expect(impact(snapshot.graph, changed, []).reasons.get('poApproval')).toBe('由 OrderCancelled 取消审批');
});

it('上下文包括链路、状态 via、候选文件与条件审查提示，保留不同强度的证据', () => {
  const tests = join(temporary, 'packages/domain/src/modules/purchase');
  const web = join(temporary, 'apps/web/src/modules/purchase');
  mkdirSync(tests, { recursive: true });
  mkdirSync(web, { recursive: true });
  writeFileSync(join(tests, 'order.test.ts'), "export const subject = 'PurchaseOrder.cancel';");
  writeFileSync(join(web, 'orders.tsx'), "import { purchaseOrder } from '@app/contracts';");
  const report = buildContext(cfg, snapshot, 'command:PurchaseOrder.cancel');
  expect(report.selection.mode).toBe('exact');
  expect(report.nodes.map((node) => node.key)).toEqual(
    expect.arrayContaining([
      'command:InventoryLock.release',
      'approval:poApproval',
      'aggregate:PurchaseOrder',
    ]),
  );
  expect(report.nodes.some((node) => node.id.startsWith('User.'))).toBe(false);
  expect(report.relations).toContainEqual(
    expect.objectContaining({ kind: 'transition', via: 'PurchaseOrder.cancel' }),
  );
  expect(report.resources.tests.project).toContain('packages/domain/src/modules/purchase/order.test.ts');
  expect(report.resources.frontend.candidates[0].file).toBe('apps/web/src/modules/purchase/orders.tsx');
  expect(report.resources.contracts).toContainEqual(
    expect.objectContaining({
      file: 'packages/contracts/src/aggregates/purchase-order/index.ts',
      generated: true,
    }),
  );
  expect(formatContext(report)).toContain('map 的执行条件');
  expect(formatContext(report)).toContain('未执行测试');
  expect(inspectGraph(snapshot, 'query:poByStatus').relations).toContainEqual(
    expect.objectContaining({
      kind: 'uses',
      evidence: expect.objectContaining({ basis: 'text-match' }),
    }),
  );
});

it('节点上限、深度边界与规则错误明确保留，不把部分子图当作完整验证', () => {
  const input = structuredClone(snapshot);
  input.findings.push({ code: 'CAGE-PAIR-002', reason: '缺少资源释放', fix: '检查释放反应' });
  const limited = buildContext(cfg, input, 'command:PurchaseOrder.cancel', { limit: 2 });
  expect(limited.nodes).toHaveLength(2);
  expect(limited.coverage.truncated).toBe(true);
  expect(limited.findings[0].code).toBe('CAGE-PAIR-002');
  const shallow = buildContext(cfg, input, 'command:PurchaseOrder.cancel', { depth: 0 });
  expect(shallow.coverage.depthBoundary).toContain('command:PurchaseOrder.cancel');
  expect(shallow.nodes).toHaveLength(1);
});

it('CLI JSON 不混入日志，每次读取实际新声明；图规则失败仍输出诊断并返回失败', () => {
  const root = join(temporary, 'live-cli');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'live-context', type: 'module' }));
  writeFileSync(join(root, 'cage.config.json'), JSON.stringify({ domain: 'domain.ts' }));
  mkdirSync(join(root, '.cage'));
  const baseline = JSON.stringify({ version: 1, nodes: [{ id: 'saved-before-query' }], edges: [], unsafeCount: 0 });
  writeFileSync(join(root, '.cage/ontology.json'), baseline);
  const source = (
    field: string,
  ) => `import { aggregate, text } from ${JSON.stringify(import.meta.resolve('@yss123/cage-kernel'))};
export const Note = aggregate('Note', { description: '通知', fields: { ${field}: text() } });`;
  const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
  const invoke = () =>
    spawnSync(process.execPath, [cli, 'context', 'aggregate:Note', '--root', root, '--format', 'json'], {
      encoding: 'utf8',
    });
  writeFileSync(join(root, 'domain.ts'), source('title'));
  const firstRun = invoke();
  // 测试领域故意没有组织模型，不能把“查到了通知”误报为整个领域检查通过。
  expect(firstRun.status).toBe(1);
  const first = JSON.parse(firstRun.stdout);
  expect(first.nodes.some((node: { id: string }) => node.id === 'Note.title')).toBe(true);
  expect(first.findings.some((finding: { code: string }) => finding.code === 'CAGE-ORG-001')).toBe(true);
  writeFileSync(join(root, 'domain.ts'), source('message'));
  const second = JSON.parse(invoke().stdout);
  expect(second.graphHash).not.toBe(first.graphHash);
  expect(second.nodes.some((node: { id: string }) => node.id === 'Note.title')).toBe(false);
  expect(second.nodes.some((node: { id: string }) => node.id === 'Note.message')).toBe(true);
  expect(readFileSync(join(root, '.cage/ontology.json'), 'utf8')).toBe(baseline);
});
