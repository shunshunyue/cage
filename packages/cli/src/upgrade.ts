/**
 * 目标版本 CLI 携带的清单升级及早期声明 codemod，供 upgrade 命令调用。
 * 收集待改清单和领域源码，dryRun 只返回路径；实际应用写入文件后同步 AGENTS 托管区。
 * 这里只支持当前 CLI 版本，不安装依赖或执行验证；后续步骤由 main 完成，失败保留可审查改动，不改历史 SQL。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { abs, type CageConfig } from './config.js';
import { sync } from './sync.js';
import { listTs } from './static-check.js';

import { VERSION } from './version.js';
export { VERSION } from './version.js';

/**
 * 递归收集清单，跳过隐藏目录、node_modules、dist 与 generated。
 * @param root 扫描根目录。
 * @returns package.json 路径；只读目录，不安装依赖，访问错误抛出。
 */
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
/**
 * 把直接 kernel command 调用中的旧 caller 属性改为 invokedBy。
 * @param source 内存源码文本，不在本函数写盘。
 * @returns 改写文本；新旧属性同时存在抛错误，命名空间或其他调用不猜改。
 */
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

/**
 * 收集并按需应用目标版本清单与领域 codemod。
 * @param cfg 当前应用位置。
 * @param opts to 须等于当前 CLI，dryRun 只列路径，codemodsOnly 不升级清单。
 * @returns 清单/源码变化路径，AGENTS 同步不列入其中；不自动回滚或运行后续安装验证。
 */
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
