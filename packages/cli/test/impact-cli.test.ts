/**
 * 验证 impact 的真实命令入口会搜索项目测试，并把结果交付为候选而非已执行证明。
 * 临时应用转导出已有采购夹具，使用独立本体文件作基线，不连接数据库或创建 Git 工作树。
 * 候选测试故意包含会抛错的代码，CLI 成功说明检索没有执行它；所有文件仅在套件临时目录内创建和清理。
 */
import { afterAll, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRegistry } from '@yss123/cage-kernel';
import * as domain from '../../testkit/test/fixtures/domain.js';
import { extract } from '../src/ontology.js';
import { formatImpact } from '../src/impact.js';

/** 本套件拥有的临时根目录，清理范围固定为 mkdtemp 的实际返回值。 */
const root = mkdtempSync(join(tmpdir(), 'cage-impact-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('基线比较列出源码相关项目测试，JSON 与文本都明确候选及分析边界', () => {
  mkdirSync(join(root, 'domain'));
  mkdirSync(join(root, 'packages/domain/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'impact-candidates', type: 'module' }));
  writeFileSync(join(root, 'cage.config.json'), JSON.stringify({ domain: 'domain/index.ts' }));
  const fixture = new URL('../../testkit/test/fixtures/domain.ts', import.meta.url).href;
  writeFileSync(join(root, 'domain/index.ts'), `export * from ${JSON.stringify(fixture)};`);
  const candidate = join(root, 'packages/domain/src/cancel.test.ts');
  writeFileSync(candidate, '// PurchaseOrder.cancel 的候选测试，检索不得执行。\nthrow new Error("候选文件被错误执行");\n');
  writeFileSync(join(root, 'packages/domain/src/unrelated.test.ts'), '// UnrelatedOperation\n');
  const base = extract(buildRegistry(domain));
  base.nodes.find((node) => node.kind === 'command' && node.id === 'PurchaseOrder.cancel')!.hash = 'previous-implementation';
  writeFileSync(join(root, 'before.json'), JSON.stringify(base));
  const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'impact', '--root', root, '--base-file', 'before.json', '--format', 'json'], { encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.start).toContain('PurchaseOrder.cancel');
  expect(report.projectTests).toContain(candidate);
  expect(report.projectTests).not.toContain(join(root, 'packages/domain/src/unrelated.test.ts'));
  expect(report.limitations.join('\n')).toContain('不分析完整导入或函数调用依赖');
  const text = formatImpact({ ...report, reasons: new Map(Object.entries(report.reasons)) }, base, { base: 'before.json', format: 'text' });
  expect(text).toContain('验证候选（尚未执行）');
  expect(text).toContain('未列出不代表不受影响');
  expect(text).not.toContain('必须运行的测试');
});
