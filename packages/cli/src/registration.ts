/**
 * 通过 TypeScript 导出符号建立静态声明到 domain 公共入口的注册证据。
 * 解析 re-export 与别名，按声明真实文件和导出名称关联入口公开名称，供 doctor 和缺失导出检查使用。
 * 不执行领域模块，不把同名但来源不同的符号混为一体；只描述入口导出关系，不证明运行时权限。
 */
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { abs, type CageConfig } from './config.js';
import type { DeclSite } from './static-check.js';

/** Resolve barrel exports with the TypeScript checker, including aliases and tsconfig paths. */
/**
 * 按 TypeScript 符号解析入口转导出、别名和路径映射，不执行模块。
 * @param cfg domain 入口与 tsconfig 所在应用。
 * @param sites 静态扫描的声明位置。
 * @returns 每条声明的公开名称和首条转导出链；空列表表示未找到证据。
 */
export function registrationEvidence(cfg: CageConfig, sites: DeclSite[]) {
  const entry = abs(cfg, cfg.domain);
  const configFile = ts.findConfigFile(cfg.root, ts.sys.fileExists);
  const parsed = configFile ? ts.parseJsonConfigFileContent(ts.readConfigFile(configFile, ts.sys.readFile).config, ts.sys, resolve(configFile, '..')) : undefined;
  const options = { ...parsed?.options, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true };
  const program = ts.createProgram([entry], options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const rootSymbol = source && checker.getSymbolAtLocation(source);
  const exports = rootSymbol ? checker.getExportsOfModule(rootSymbol) : [];
  const normalized = (file: string) => resolve(file).replace(/\\/g, '/').toLowerCase();
  const exported = new Map<string, string[]>();
  for (const symbol of exports) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const declaration of target.declarations ?? []) {
      const name = (declaration as ts.NamedDeclaration).name;
      if (!name || !ts.isIdentifier(name)) continue;
      const key = `${normalized(declaration.getSourceFile().fileName)}:${name.text}`;
      exported.set(key, [...(exported.get(key) ?? []), symbol.name]);
    }
  }
  const paths = new Map<string, string[]>([[normalized(entry), [cfg.domain]]]);
  const queue = source ? [source] : [];
  for (const file of queue) {
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, file.fileName, options, ts.sys).resolvedModule;
      const next = resolved && program.getSourceFile(resolved.resolvedFileName);
      if (!next || paths.has(normalized(next.fileName))) continue;
      paths.set(normalized(next.fileName), [...paths.get(normalized(file.fileName))!, relative(cfg.root, next.fileName).replace(/\\/g, '/')]);
      queue.push(next);
    }
  }
  return sites.map(site => ({ name: site.exportName, file: site.file, line: site.line,
    exportedAs: exported.get(`${normalized(abs(cfg, site.file))}:${site.exportName}`) ?? [],
    chain: paths.get(normalized(abs(cfg, site.file))) ?? [] }));
}
