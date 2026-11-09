/**
 * 从本体声明生成通用性质测试及 Vitest 配置，由 cage test 和 verify 驱动。
 * 按能力、状态、范围、审计、幂等、掩码和不变量生成代码，真实执行委托 cage-testkit。
 * 生成器不能推断所有合法业务夹具；生成用例允许显式 skip，生成数量不等于已覆盖业务需求。
 */
// 派生测试生成器：遍历本体图，按固定模板为每个能力点、每个范围组合子、每条非法迁移生成测试。
// 生成到 generated/tests，不入库，每次运行前重新生成。
import { existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { abs, type CageConfig } from './config.js';
import type { Ontology, OntNode } from './ontology.js';

/**
 * 生成性质测试的目录索引，供影响分析按主体挑选候选；不是测试执行结果。
 */
export interface DerivedTest {
  /** 派生测试相对 generated/tests 目录的文件名，调用者结合配置解析完整路径。 */
  file: string;
  /** 验证类别与主体组合的测试名，用于报告及候选选择。 */
  name: string;
  /** 这个测试守护的本体节点（影响分析据此挑选要运行的测试） */
  subject: string;
}

/**
 * 把主体和测试名称编码成合法 TS 字符串字面量，不将业务文案作为生成代码拼接执行。
 */
const q = (s: string) => JSON.stringify(s);

/**
 * 生成每个测试文件的共享 setup/teardown 代码，使用领域入口建立 testkit 环境。
 * @param domainImport 生成目录到 domain 的导入路径。
 * @returns 源码行数组；仅拼接文本，不初始化数据库。
 */
function header(domainImport: string): string[] {
  return [
    '// 生成物：派生测试（cage test 每次运行前重新生成，不要手改）',
    `import { afterAll, beforeAll, expect, it } from 'vitest';`,
    `import { derived } from '@yss123/cage-testkit';`,
    `import * as domain from ${q(domainImport)};`,
    '',
    'const t = derived(domain);',
    'beforeAll(() => t.setup());',
    'afterAll(() => t.teardown());',
    '',
  ];
}

/**
 * 筛选当前本体中的命令节点，作为派生验证的主体集合。
 */
const commands = (g: Ontology) => g.nodes.filter((n) => n.kind === 'command');
/**
 * 只为声明允许 user 的命令生成用户能力验证，内部流程命令不补造用户入口。
 */
const userInvokable = (c: OntNode) => (c.attrs.invokedBy as string[]).includes('user');
/**
 * 从命令能力标识取得聚合前缀，与抽取器使用的 Aggregate.command 命名约定一致。
 */
const aggOf = (c: OntNode) => c.id.split('.')[0];

/**
 * 按本体生成通用性质用例文本及 subject 索引。
 * @param cfg 决定生成目录和领域导入相对路径。
 * @param g 当前本体，提供用户调用能力、状态、范围和不变量。
 * @returns 待写文件内容与用例索引；不写盘、不执行测试，skip 处理留在生成用例里。
 */
export function deriveTests(
  cfg: CageConfig,
  g: Ontology,
): { files: Record<string, string>; tests: DerivedTest[] } {
  const dir = abs(cfg, join(cfg.generated, 'tests'));
  const domainImport = relative(dir, abs(cfg, cfg.domain))
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '');
  const imp = domainImport.startsWith('.') ? domainImport : `./${domainImport}`;
  const files: Record<string, string> = {};
  const tests: DerivedTest[] = [];
  const add = (file: string, name: string, subject: string, body: string[]) => {
    files[file] ??= header(imp).join('\n');
    files[file] += `\nit(${q(name)}, async (ctx) => {\n${body.map((l) => `  ${l}`).join('\n')}\n});\n`;
    tests.push({ file, name, subject });
  };

  // 能力：每个能力点，缺少它的用户调用，断言 FORBIDDEN
  for (const c of commands(g).filter(userInvokable)) {
    add('capability.test.ts', `${c.id}：没有能力点时被拒绝`, c.id, [
      `const r = await t.capabilityDenied(${q(c.id)});`,
      `if (r === 'skip') return ctx.skip();`,
      `expect(r.code).toBe('FORBIDDEN');`,
    ]);
  }

  // 状态：每个命令、每个不在 from 中的状态，断言 INVALID_TRANSITION
  for (const c of commands(g)) {
    if (c.attrs.from === 'new') continue;
    const from = c.attrs.from as string[];
    const states = g.nodes
      .filter((n) => n.kind === 'state' && n.id.startsWith(`${aggOf(c)}.`))
      .map((n) => n.id.slice(aggOf(c).length + 1));
    for (const s of states.filter((x) => !from.includes(x))) {
      add('state.test.ts', `${c.id}：在 ${s} 状态下被拒绝`, c.id, [
        `const r = await t.invalidTransition(${q(c.id)}, ${q(s)});`,
        `if (r === 'skip') return ctx.skip();`,
        `expect(r.code).toBe('INVALID_TRANSITION');`,
      ]);
    }
  }

  // 范围：每个聚合、每个范围组合子，范围外的数据读、列表、安全视图都拿不到，基表碰不到
  for (const a of g.nodes.filter((n) => n.kind === 'aggregate')) {
    const sc = a.attrs.scope as { dept: string | null; owner: string | null };
    for (const comb of ['self', 'dept'] as const) {
      if (comb === 'self' && !sc.owner) continue;
      if (comb === 'dept' && (!sc.dept || sc.dept === 'id')) continue;
      add('scope.test.ts', `${a.id}：范围 ${comb} 之外的数据读不到`, a.id, [
        `const r = await t.scopeHidden(${q(a.id)}, ${q(comb)});`,
        `if (r === 'skip') return ctx.skip();`,
        `expect(r.get).toBe('NOT_FOUND');`,
        `expect(r.listed).toBe(false);`,
        `expect(r.rawVisible).toBe(false);`,
        `expect(r.baseDenied).toBe(true);`,
      ]);
    }
    if (sc.owner) {
      for (const c of commands(g).filter(
        (x) => aggOf(x) === a.id && userInvokable(x) && x.attrs.from !== 'new',
      )) {
        add('scope.test.ts', `${c.id}：写范围外的数据返回 NOT_FOUND`, c.id, [
          `const r = await t.outOfScopeWrite(${q(c.id)});`,
          `if (r === 'skip') return ctx.skip();`,
          `expect(r.code).toBe('NOT_FOUND');`,
        ]);
      }
    }
  }

  // 审计：每个命令的成功路径都产生且仅产生一条审计
  for (const c of commands(g)) {
    add('audit.test.ts', `${c.id}：成功时写且只写一条审计`, c.id, [
      `const r = await t.auditOnce(${q(c.id)});`,
      `if (r === 'skip') return ctx.skip();`,
      `expect(r.rows).toBe(1);`,
    ]);
  }

  // 幂等：每个聚合挑一个非新建的用户命令
  for (const a of g.nodes.filter((n) => n.kind === 'aggregate')) {
    const c =
      commands(g).find((x) => aggOf(x) === a.id && userInvokable(x) && x.attrs.from !== 'new') ??
      commands(g).find((x) => aggOf(x) === a.id && userInvokable(x));
    if (!c) continue;
    add('idempotency.test.ts', `${c.id}：同一幂等键重复提交只执行一次`, c.id, [
      `const r = await t.idempotent(${q(c.id)});`,
      `if (r === 'skip') return ctx.skip();`,
      `expect(r.same).toBe(true);`,
      `expect(r.rows).toBe(1);`,
    ]);
  }

  // 脱敏：没有 unmask 能力时读到的是掩码值
  for (const a of g.nodes.filter((n) => n.kind === 'aggregate')) {
    const sens = g.nodes.filter(
      (n) => n.kind === 'field' && n.id.startsWith(`${a.id}.`) && n.attrs.sensitive && !n.attrs.hidden,
    );
    if (sens.length === 0) continue;
    add('mask.test.ts', `${a.id}：敏感字段默认掩码`, a.id, [
      `const r = await t.masked(${q(a.id)});`,
      `if (r === 'skip') return ctx.skip();`,
      `for (const f of r) expect(f.seen, f.field).not.toBe(f.plain);`,
    ]);
  }

  // 不变量：随机命令序列，断言每步之后不变量成立
  for (const a of g.nodes.filter(
    (n) => n.kind === 'aggregate' && ((n.attrs.invariants as string[]) ?? []).length > 0,
  )) {
    add('invariant.test.ts', `${a.id}：随机命令序列之后不变量始终成立`, a.id, [
      `const r = await t.invariantsHold(${q(a.id)});`,
      `if (r === 'skip') return ctx.skip();`,
      `expect(r.violations).toEqual([]);`,
    ]);
  }

  return { files, tests };
}

/**
 * 写入本轮派生测试，先清理当前生成器拥有的固定文件名。
 * @param cfg 决定 generated/tests 位置。
 * @param files deriveTests 产生的文件映射。
 * @returns 测试目录绝对路径；用户额外文件不会被递归删除，IO 失败直接抛出。
 */
export function writeDerived(cfg: CageConfig, files: Record<string, string>): string {
  const dir = abs(cfg, join(cfg.generated, 'tests'));
  // 只清理本生成器拥有的测试文件，不递归删除配置指向的整个目录。
  if (existsSync(dir))
    for (const name of readdirSync(dir)) {
      if (/^(capability|state|scope|audit|idempotency|mask|invariant)\.test\.ts$/.test(name))
        unlinkSync(join(dir, name));
    }
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/**
 * 生成用于本次测试进程的 Vitest 配置字符串。
 * @param cfg 应用根与派生测试位置。
 * @param only derived 仅派生、project 仅项目，省略时两者都包含。
 * @returns 使用 testkit 全局准备的配置源码；超时单位为毫秒，不在此处启动测试。
 */
export function vitestConfig(cfg: CageConfig, only?: 'derived' | 'project'): string {
  const include =
    only === 'derived'
      ? [`${cfg.generated}/tests/**/*.test.ts`]
      : only === 'project'
        ? ['packages/**/src/**/*.test.ts', 'apps/api/**/*.test.ts']
        : [`${cfg.generated}/tests/**/*.test.ts`, 'packages/**/src/**/*.test.ts', 'apps/api/**/*.test.ts'];
  return `// 生成物：cage test 的 Vitest 配置
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: ${q(cfg.root.replace(/\\/g, '/'))},
    include: ${JSON.stringify(include)},
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['@yss123/cage-testkit/global-setup'],
    testTimeout: 60000,
    hookTimeout: 180000,
    fileParallelism: true,
  },
});
`;
}
