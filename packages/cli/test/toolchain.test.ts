// 工具链反例：测试检查器是否能发现具体缺陷，而不是复述生成器内部实现。
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, buildRegistry, command, states, text, scope } from '@yss123/cage-kernel';
import * as domain from '../../testkit/test/fixtures/domain.js';
import { extract } from '../src/ontology.js';
import { checkPairing, checkEventCompat, runRules } from '../src/rules.js';
import { impact } from '../src/impact.js';
import { syncManagedBlock, managedBlock } from '../src/sync.js';
import { codemodSource } from '../src/upgrade.js';
import { loadConfig } from '../src/config.js';
import { staticCheck, unexportedFindings } from '../src/static-check.js';
import { generate } from '../src/gen/index.js';
import { deriveTests } from '../src/derive.js';
import { run } from '../src/process.js';
import { loadProjectEnv } from '../src/env.js';
import { setupDatabase } from '../src/database.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const reg = buildRegistry(domain);
const graph = extract(reg);
const temporary = mkdtempSync(join(tmpdir(), 'cage-cli-test-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

it('数据库配置由框架生成，角色密码各自独立，重复 setup 不轮换已有密码', () => {
  const root = join(temporary, 'database-project');
  mkdirSync(root);
  writeFileSync(join(root, 'cage.config.json'), '{"devDbPort":55432}');
  const cfg = loadConfig(root);
  expect(setupDatabase(cfg)).toBe(true);
  const before = readFileSync(join(root, '.env'), 'utf8');
  const env: NodeJS.ProcessEnv = {};
  loadProjectEnv(root, env);
  const urls = ['APP', 'READ', 'MIGRATE'].map((role) => new URL(env[`CAGE_${role}_DATABASE_URL`]!));
  expect(urls.map((url) => url.username)).toEqual(['cage_app', 'cage_read', 'cage_migrate']);
  expect(urls.every((url) => url.port === '55432')).toBe(true);
  expect(new Set(urls.map((url) => url.password)).size).toBe(3);
  expect(new URL(env.CAGE_TEST_DATABASE_URL!).port).toBe('55433');
  expect(setupDatabase(cfg)).toBe(false);
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe(before);
});

it('项目 .env 提供本地连接，部署环境中的值优先且不会执行文件中的 shell 表达式', () => {
  const root = join(temporary, 'env-project');
  mkdirSync(root);
  writeFileSync(
    join(root, '.env'),
    'CAGE_APP_DATABASE_URL="postgres://local/db"\nCAGE_STAGE=fake\nLITERAL="$(echo should-not-run)"\n',
  );
  const env: NodeJS.ProcessEnv = { CAGE_STAGE: 'test' };
  loadProjectEnv(root, env);
  expect(env.CAGE_APP_DATABASE_URL).toBe('postgres://local/db');
  expect(env.CAGE_STAGE).toBe('test');
  expect(env.LITERAL).toBe('$(echo should-not-run)');
});

describe('图规则与影响分析', () => {
  it('保留状态的回执命令在每个允许状态上形成自环，新建不能省略目标状态', () => {
    const Receipt = aggregate('Receipt', {
      fields: { reference: text() },
      states: states('open', 'closed', { terminal: ['closed'] }),
      scope: scope.none(),
    });
    const acknowledge = command(Receipt, { from: ['open', 'closed'], to: null, handler: (o) => o });
    const g = extract(buildRegistry({ Receipt, acknowledge }));
    expect(g.edges.filter((edge) => edge.kind === 'transition')).toEqual([
      { kind: 'transition', from: 'Receipt.open', to: 'Receipt.open', via: 'Receipt.acknowledge' },
      { kind: 'transition', from: 'Receipt.closed', to: 'Receipt.closed', via: 'Receipt.acknowledge' },
    ]);
    // JavaScript 调用者没有类型检查，也必须在声明加载时拒绝没有初始状态的新建命令。
    expect(() => command(Receipt, { from: 'new', to: null, handler: (o: unknown) => o } as any)).toThrow(
      'CAGE-CMD-003',
    );
  });
  it('Git 换行转换不会改变声明的语义哈希', () => {
    const site = {
      exportName: 'create',
      primitive: 'command',
      file: 'domain.ts',
      line: 1,
      text: 'command(\n  PurchaseOrder, {}\n)',
      domainCodes: [],
    };
    const a = extract(reg, [site]);
    const b = extract(reg, [{ ...site, text: site.text.replaceAll('\n', '\r\n') }]);
    expect(impact(a, b, []).affected).toEqual([]);
  });
  it('采购、审批、库存和 ERP 的完整声明能通过图规则', () => {
    expect(runRules(graph)).toEqual([]);
  });
  it('撤回审批漏解锁被 CAGE-PAIR-002 拦下', () => {
    const broken = structuredClone(graph);
    broken.edges.push({
      kind: 'transition',
      from: 'PurchaseOrder.approved',
      to: 'PurchaseOrder.pending_approval',
      via: 'PurchaseOrder.revoke',
    });
    expect(checkPairing(broken)).toEqual([
      expect.objectContaining({
        code: 'CAGE-PAIR-002',
        reason: expect.stringContaining('PurchaseOrder.revoke'),
      }),
    ]);
  });
  it('缺失释放反应时所有受影响迁移都会报错', () => {
    const broken = structuredClone(graph);
    broken.edges = broken.edges.filter((e) => !e.releases);
    expect(checkPairing(broken).map((f) => f.reason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PurchaseOrder.cancel'),
        expect.stringContaining('PurchaseOrder.markReceived'),
      ]),
    );
  });
  it('金额口径变化能追到额度约束与审批路由', () => {
    const changed = structuredClone(graph);
    const field = changed.nodes.find((n) => n.kind === 'field' && n.id === 'PurchaseOrder.amount')!;
    field.hash = 'new-meaning';
    field.attrs.description = '不含税金额';
    const result = impact(graph, changed, []);
    expect(result.affected).toEqual(
      expect.arrayContaining(['PurchaseOrder.approve', 'poApproval', 'route:po-approval', 'OrderSubmitted']),
    );
  });
  it('删除事件字段会阻断兼容性门禁', () => {
    const changed = structuredClone(graph);
    const event = changed.nodes.find((n) => n.kind === 'event' && n.id === 'OrderSubmitted')!;
    delete (event.attrs.fields as any).amount;
    expect(checkEventCompat(graph, changed)).toEqual([expect.objectContaining({ code: 'CAGE-EVENT-002' })]);
  });
});

describe('托管区和升级', () => {
  it('同步只改托管区，逐字保留项目前后文，并且幂等', () => {
    const input = '项目序言\n<!-- cage:begin old -->\n旧规则\n<!-- cage:end -->\n自定义约定\n';
    const output = syncManagedBlock(input);
    expect(output).toBe('项目序言\n' + managedBlock + '\n自定义约定\n');
    expect(syncManagedBlock(output)).toBe(output);
  });
  it('损坏的托管区报错，不覆盖项目内容', () => {
    expect(() => syncManagedBlock('<!-- cage:begin old -->\n项目说明')).toThrow('CAGE-SYNC-001');
  });
  it('codemod 支持导入别名，保留无关对象，重复运行没有变化', () => {
    const input =
      "import { command as cmd } from '@yss123/cage-kernel';\nconst x = cmd(A, { caller: 'user' });\nconst y = other(A, { caller: 'job' });\n";
    const output = codemodSource(input);
    expect(output).toContain("invokedBy: 'user'");
    expect(output).toContain("other(A, { caller: 'job' })");
    expect(codemodSource(output)).toBe(output);
  });
});

describe('静态边界与生成一致性', () => {
  function project(name: string, source: string) {
    const root = join(temporary, name);
    mkdirSync(join(root, 'packages/domain/src'), { recursive: true });
    writeFileSync(join(root, 'cage.config.json'), '{}');
    writeFileSync(join(root, 'packages/domain/src/index.ts'), source);
    return loadConfig(root);
  }
  it.each([
    ["import pg from 'pg';", 'CAGE-DEP-001'],
    ["export function build() { return aggregate('Bad', {}); }", 'CAGE-DECL-001'],
    ["export const bad = true ? aggregate('Bad', {}) : null;", 'CAGE-DECL-001'],
    ["const Bad = aggregate('Bad', {});", 'CAGE-DECL-003'],
  ])('阻断 %s', (source, code) => {
    expect(staticCheck(project(code + Math.random(), source)).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });
  it('声明文件漏导出会明确指出名称', () => {
    const result = staticCheck(project('unexported', "export const Hidden = aggregate('Hidden', {});"));
    expect(unexportedFindings(result.sites, new Set())).toEqual([
      expect.objectContaining({ code: 'CAGE-DECL-002' }),
    ]);
  });
  it.each([
    "import { aggregate as entity } from '@yss123/cage-kernel'; export function build() { return entity('Hidden', {}); }",
    "import * as cage from '@yss123/cage-kernel'; export function build() { return cage.aggregate('Hidden', {}); }",
  ])('导入别名和命名空间不能绕过静态检查', (source) => {
    expect(staticCheck(project('alias-' + Math.random(), source)).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CAGE-DECL-001' })]),
    );
  });
  it('生成可重复运行；check 能抓到契约手改且不改写文件', () => {
    const cfg = project('generation', '');
    const first = generate(cfg, reg, graph, []);
    expect(first.migrationDraft).toBeTruthy();
    expect(generate(cfg, reg, graph, [], { check: true }).findings).toEqual([]);
    const file = join(cfg.root, cfg.contracts, 'purchase-order.ts');
    writeFileSync(file, '// 意外手改');
    expect(generate(cfg, reg, graph, [], { check: true }).findings).toEqual([
      expect.objectContaining({ code: 'CAGE-GEN-001' }),
    ]);
    expect(readFileSync(file, 'utf8')).toBe('// 意外手改');
  });
  it('派生测试包含能力、范围、非法状态、审计和幂等类别', () => {
    const cfg = project('derived', '');
    const result = deriveTests(cfg, graph);
    expect(Object.keys(result.files)).toEqual(
      expect.arrayContaining([
        'capability.test.ts',
        'scope.test.ts',
        'state.test.ts',
        'audit.test.ts',
        'idempotency.test.ts',
      ]),
    );
    expect(result.tests.some((t) => t.subject === 'PurchaseOrder.submit')).toBe(true);
  });
});

describe('命令行门禁退出码', () => {
  it('子进程失败会返回非零退出码，不被包装器吞掉', async () => {
    const file = join(temporary, 'failure.mjs');
    writeFileSync(file, 'process.exitCode = 7;');
    expect(await run(file, [], temporary)).toBe(7);
  });
  it('未知参数返回失败；帮助入口无需项目即可运行', () => {
    const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
    expect(spawnSync(process.execPath, [cli, '--not-a-real-option'], { encoding: 'utf8' }).status).toBe(1);
    expect(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).status).toBe(0);
  });
});
