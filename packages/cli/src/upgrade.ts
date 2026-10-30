import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { abs, type CageConfig } from './config.js';
import { sync } from './sync.js';
import { listTs } from './static-check.js';

import { VERSION } from './version.js';
export { VERSION } from './version.js';

export function projectManifests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'generated'].includes(e.name)) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name === 'package.json') out.push(path);
    }
  };
  walk(root);
  return out;
}

/** 0.1 接收早期样例里的 caller 写法，运行时规范名为 invokedBy。只改从 kernel 导入的 command。 */
export function codemodSource(source: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('domain.ts', source);
  const names = new Set(
    file
      .getImportDeclarations()
      .filter((i) => i.getModuleSpecifierValue() === '@yss123/cage-kernel')
      .flatMap((i) =>
        i
          .getNamedImports()
          .filter((n) => n.getName() === 'command')
          .map((n) => n.getAliasNode()?.getText() ?? n.getName()),
      ),
  );
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!names.has(call.getExpression().getText())) continue;
    const obj = call.getArguments()[1]?.asKind(SyntaxKind.ObjectLiteralExpression);
    const old = obj?.getProperty('caller')?.asKind(SyntaxKind.PropertyAssignment);
    if (old && obj?.getProperty('invokedBy'))
      throw new Error('[CAGE-UPGRADE-001] command 同时包含 caller 与 invokedBy，请手工消除歧义');
    old?.rename('invokedBy');
  }
  return file.getFullText();
}

export function upgrade(
  cfg: CageConfig,
  opts: { to?: string; dryRun?: boolean; codemodsOnly?: boolean } = {},
) {
  const version = opts.to ?? VERSION;
  if (version !== VERSION)
    throw new Error(
      `[CAGE-UPGRADE-001] 当前 CLI 只包含 ${VERSION} 的迁移；请先安装目标版本的 @yss123/cage-cli 再执行 upgrade`,
    );
  const changes = new Map<string, string>();
  if (!opts.codemodsOnly)
    for (const file of projectManifests(cfg.root)) {
      const before = readFileSync(file, 'utf8');
      const p = JSON.parse(before);
      let changed = false;
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(p[group] ?? {}))
          if (name.startsWith('@yss123/cage-') && p[group][name] !== version) {
            p[group][name] = version;
            changed = true;
          }
      }
      if (changed) changes.set(file, JSON.stringify(p, null, 2) + '\n');
    }
  // 只重写业务声明目录，不扫描依赖包、生成契约或已经发布的 SQL。
  for (const file of listTs(dirname(abs(cfg, cfg.domain)))) {
    const before = readFileSync(file, 'utf8');
    const after = codemodSource(before);
    if (before !== after) changes.set(file, after);
  }
  if (!opts.dryRun) {
    for (const [file, content] of changes) writeFileSync(file, content);
    sync(cfg);
  }
  return [...changes.keys()];
}
