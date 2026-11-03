// 工具链反例：测试检查器是否能发现具体缺陷，而不是复述生成器内部实现。
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createApp } from '../src/create.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { databaseConnectionError } from '../src/migrate.js';

const reg = buildRegistry(domain);
const graph = extract(reg);
const temporary = mkdtempSync(join(tmpdir(), 'cage-cli-test-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

it('新项目保留已有数据库配置入口，不分发数据库生命周期命令', () => {
  const root = createApp(join(temporary, 'configured-database'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(Object.keys(pkg.scripts).filter((key) => key.startsWith('db:'))).toEqual([]);
  expect(pkg.scripts.migrate).toBe('cage migrate');
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  expect(example).toContain('同一个数据库');
  expect(example).toContain('CAGE_APP_DATABASE_URL=');
  expect(example).toContain('CAGE_READ_DATABASE_URL=');
  expect(example).toContain('CAGE_MIGRATE_DATABASE_URL=');
  expect(existsSync(join(root, 'compose.yaml'))).toBe(false);
  expect(existsSync(join(root, '.env'))).toBe(false);
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.env');
  expect(existsSync(join(root, '_gitignore'))).toBe(false);
});

it.each(['blank', 'purchase'] as const)('%s 模板交付完整本地教材，且只注册所选业务', (template) => {
  const root = createApp(join(temporary, 'ai-business-guide-' + template), undefined, template);
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('docs/ai/README.md');
  expect(agents).toContain('项目自己的业务约定');
  expect(agents).toContain(managedBlock);
  expect(agents).not.toContain('../../docs/');
  // 检查实际创建结果，不只检查规范文档，能抓到模板复制或打包遗漏。
  for (const file of [
    'docs/ai/README.md',
    'docs/ai/architecture.md',
    'docs/ai/project-structure.md',
    'docs/ai/primitives.md',
    'docs/ai/workflow.md',
    'docs/ai/ontology-context.md',
    'docs/ai/recipes.md',
    'docs/ai/purchase-example.md',
    'docs/ai/troubleshooting.md',
    'docs/ai/transfers.md',
    'docs/errors/README.md',
    'docs/errors/runtime.md',
    'docs/errors/CAGE-APPR-007.md',
    'docs/errors/CAGE-PAIR-002.md',
  ])
    expect(existsSync(join(root, file)), file).toBe(true);
  const reference = template === 'blank' ? 'docs/examples/purchase-admin' : '';
  for (const name of [
    'modules/purchase/purchase-order.ts',
    'workflows/purchase-inventory.ts',
    'modules/purchase/approvals.ts',
    'integrations/erp.ts',
  ])
    expect(existsSync(join(root, reference, 'packages/domain/src', name)), name).toBe(true);
  const migration = readFileSync(join(root, 'db/migrations/0001_init.sql'), 'utf8');
  const contracts = readFileSync(join(root, 'packages/contracts/src/index.ts'), 'utf8');
  if (template === 'blank') {
    // 看实际分发结果，防止“空白”只换了首页，后台仍然注册采购并建业务表。
    expect(existsSync(join(root, 'packages/domain/src/modules/purchase'))).toBe(false);
    expect(migration).not.toContain('purchase_order');
    expect(migration).not.toContain('inventory');
    expect(contracts).not.toContain('PurchaseOrder');
    expect(contracts).toContain('User.read');
    expect(readFileSync(join(root, 'apps/api/src/worker.ts'), 'utf8')).not.toContain('fakeConnector');
  } else {
    expect(migration).toContain('purchase_order');
    expect(contracts).toContain('PurchaseOrder.read');
  }
  expect(JSON.parse(readFileSync(join(root, 'cage.config.json'), 'utf8')).structure).toBe('modular');
  for (const path of [
    'apps/web/src/app/app.tsx',
    'apps/web/src/modules/auth/pages/login-page.tsx',
    'apps/web/src/shared',
    'packages/contracts/src/aggregates/user/index.ts',
  ])
    expect(existsSync(join(root, path)), path).toBe(true);
  expect(existsSync(join(root, 'packages/contracts/src/user.ts'))).toBe(false);
  expect(readFileSync(join(root, 'apps/web/src/main.tsx'), 'utf8')).not.toContain('function Workspace');
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('(docs/ai/README.md)');
  expect(readFileSync(join(root, 'docs/errors/CAGE-APPR-007.md'), 'utf8')).toContain('重放');
  expect(readFileSync(join(root, 'docs/ai/primitives.md'), 'utf8')).toContain(
    'export const Note = aggregate',
  );
});

it('创建入口支持显式模板，非交互缺参数或未知模板在写文件前报错', () => {
  const bin = fileURLToPath(new URL('../bin/create-cage-app.js', import.meta.url));
  const destination = join(temporary, 'from-bin');
  for (const args of [[destination], [destination, '--template', 'unknown']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CAGE-CREATE-001');
    expect(existsSync(destination)).toBe(false);
  }
  const result = spawnSync(process.execPath, [bin, destination, '--template', 'blank'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('空白业务项目');
  expect(existsSync(join(destination, 'packages/domain/src/index.ts'))).toBe(true);
});

it('缺少连接时 dev 明确失败，不创建数据库或生成凭证', () => {
  const root = join(temporary, 'missing-database');
  mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'DATABASE_URL' || key.startsWith('CAGE_')) delete env[key];
  }
  const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'dev', '--root', root], { encoding: 'utf8', env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('CAGE-ENV-001');
  expect(existsSync(join(root, '.env'))).toBe(false);
  expect(existsSync(join(root, '.cage', 'postgres'))).toBe(false);
});

it('数据库认证失败提示检查 .env，且不泄露密码', () => {
  const error = databaseConnectionError(
    { code: '28P01' },
    'postgresql://cage_migrate:never-print-this@127.0.0.1:54329/cage_dev',
  );
  expect(error.message).toContain('127.0.0.1:54329/cage_dev');
  expect(error.message).toContain('.env');
  expect(error.message).not.toContain('cage db');
  expect(error.message).not.toContain('never-print-this');
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
    const file = join(cfg.root, cfg.contracts, 'aggregates/purchase-order/index.ts');
    writeFileSync(file, '// 意外手改');
    expect(generate(cfg, reg, graph, [], { check: true }).findings).toEqual([
      expect.objectContaining({ code: 'CAGE-GEN-001' }),
    ]);
    expect(readFileSync(file, 'utf8')).toBe('// 意外手改');
  });
  it('生成布局升级报告并清理旧契约，保留手写文件，公共入口仍导出聚合 API', () => {
    const cfg = project('stale-contracts', '');
    generate(cfg, reg, graph, []);
    const old = join(cfg.root, cfg.contracts, 'purchase-order.ts');
    const custom = join(cfg.root, cfg.contracts, 'custom.ts');
    writeFileSync(old, '// 生成物：由 cage gen 从 domain 声明生成，不要手改。\nexport {};\n');
    writeFileSync(custom, '// 项目手写扩展\nexport {};\n');
    expect(generate(cfg, reg, graph, [], { check: true }).findings).toEqual([
      expect.objectContaining({ code: 'CAGE-GEN-001', at: old }),
    ]);
    expect(existsSync(old)).toBe(true);
    generate(cfg, reg, graph, []);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(custom)).toBe(true);
    expect(readFileSync(join(cfg.root, cfg.contracts, 'index.ts'), 'utf8')).toContain(
      "export * from './aggregates/purchase-order'",
    );
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
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).not.toMatch(/db\s+(setup|up|init|down|status)/);
    expect(spawnSync(process.execPath, [cli, 'migrate', '--init'], { encoding: 'utf8' }).status).toBe(1);
    const removed = spawnSync(process.execPath, [cli, 'db', 'setup', '--root', temporary], {
      encoding: 'utf8',
    });
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain('未知命令 db');
  });
});
