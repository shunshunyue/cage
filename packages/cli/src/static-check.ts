// 静态检查：导入之前先用 TypeScript 编译器 API 扫一遍源码，确保没有声明藏在函数、条件或循环里（那样抽取器就看不到它），
// 并记下每个声明的位置（影响分析把 handler 文件的改动映射到它所属的命令）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import type { CageConfig } from './config.js';
import type { Finding } from './findings.js';

export const PRIMITIVES = new Set([
  'aggregate',
  'states',
  'command',
  'event',
  'reaction',
  'query',
  'approval',
  'job',
  'connector',
  'outbound',
  'inbound',
  'route',
]);

const IO_MODULES =
  /^(node:)?(fs|fs\/promises|net|http|https|http2|child_process|dgram|tls|worker_threads|cluster)(\/|$)|^(pg|kysely|axios|undici|node-fetch|got|@yss123\/cage-http|@yss123\/cage-kernel\/db|@yss123\/cage-kernel\/worker)(\/|$)/;

export interface DeclSite {
  exportName: string;
  primitive: string;
  file: string;
  line: number;
  /** 声明调用的源码（用于哈希与业务错误码提取） */
  text: string;
  /** handler 里 fail('CODE') 的业务错误码 */
  domainCodes: string[];
}

export interface StaticResult {
  sites: DeclSite[];
  findings: Finding[];
  unsafeCount: number;
  files: string[];
}

export function listTs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
        out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n) ||
    ts.isClassDeclaration(n)
  );
}

function isControl(n: ts.Node): boolean {
  return (
    ts.isIfStatement(n) ||
    ts.isForStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isWhileStatement(n) ||
    ts.isDoStatement(n) ||
    ts.isSwitchStatement(n) ||
    ts.isTryStatement(n) ||
    ts.isConditionalExpression(n) ||
    ts.isBlock(n)
  );
}

function calleeName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

export function staticCheck(cfg: CageConfig): StaticResult {
  const domainDir = dirname(join(cfg.root, cfg.domain));
  const files = listTs(domainDir);
  const sites: DeclSite[] = [];
  const findings: Finding[] = [];
  let unsafeCount = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const rel = relative(cfg.root, file).replace(/\\/g, '/');
    const loc = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    // 别名和命名空间导入同样属于框架声明，不能因为换了写法就跳过检查。
    const aliases = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of sf.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith('@yss123/cage-')
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements)
          aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    }
    const primitiveName = (call: ts.CallExpression) => {
      const expression = call.expression;
      if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text)
      )
        return expression.name.text;
      return null;
    };

    const visit = (node: ts.Node) => {
      // 依赖规则：声明和 handler 不能做 IO
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (IO_MODULES.test(spec)) {
          findings.push({
            code: 'CAGE-DEP-001',
            at: loc(node),
            reason: `声明文件导入了 IO 模块 ${spec}`,
            fix: '需要外部数据就声明 reads；需要通知外部系统就发事件，由连接器的出站映射处理',
          });
        }
      }
      if (ts.isCallExpression(node)) {
        const name = primitiveName(node);
        if (name === 'fetch' || node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          findings.push({
            code: 'CAGE-DEP-004',
            at: loc(node),
            reason: name === 'fetch' ? 'handler 里直接发网络请求' : '声明文件里使用了动态 import',
            fix: '第三方调用改为连接器声明 + outbound 出站映射',
          });
        }
        if (name === 'unsafe') unsafeCount++;
        if (name && PRIMITIVES.has(name)) {
          let cur: ts.Node = node;
          let bad: ts.Node | null = null;
          let topDecl: ts.VariableDeclaration | null = null;
          while (cur.parent) {
            const p: ts.Node = cur.parent;
            if (isFunctionLike(p) || isControl(p)) {
              bad = p;
              break;
            }
            if (
              ts.isVariableDeclaration(p) &&
              p.parent &&
              ts.isVariableDeclarationList(p.parent) &&
              p.parent.parent &&
              ts.isVariableStatement(p.parent.parent) &&
              p.parent.parent.parent === sf
            ) {
              topDecl = p;
              break;
            }
            if (ts.isExpressionStatement(p) && p.parent === sf) break;
            cur = p;
          }
          if (bad) {
            findings.push({
              code: 'CAGE-DECL-001',
              at: loc(node),
              reason: `原语 ${name}() 写在函数、条件或循环里，抽取器看不到它`,
              fix: '原语必须在模块顶层用 export const 声明',
            });
          } else if (!topDecl) {
            findings.push({
              code: 'CAGE-DECL-001',
              at: loc(node),
              reason: `原语 ${name}() 没有赋值给顶层常量`,
              fix: '写成 export const 名字 = ' + name + '(...)',
            });
          } else {
            const stmt = topDecl.parent.parent as ts.VariableStatement;
            const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
            const isConst = (topDecl.parent.flags & ts.NodeFlags.Const) !== 0;
            if (topDecl.initializer === node) {
              if (!exported || !isConst) {
                findings.push({
                  code: 'CAGE-DECL-003',
                  at: loc(node),
                  reason: `声明 ${topDecl.name.getText()} 没有用 export const 导出`,
                  fix: '加上 export const，并确认它从 domain 的 index.ts 导出',
                });
              } else if (ts.isIdentifier(topDecl.name)) {
                const t = node.getText();
                const codes = [...t.matchAll(/fail\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g)].map((m) => m[1]);
                sites.push({
                  exportName: topDecl.name.text,
                  primitive: name,
                  file: rel,
                  line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                  text: t,
                  domainCodes: [...new Set(codes)],
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // 同名导出：export * 遇到重名会悄悄把两个都丢掉
  const byName = new Map<string, DeclSite[]>();
  for (const s of sites) byName.set(s.exportName, [...(byName.get(s.exportName) ?? []), s]);
  for (const [n, list] of byName) {
    if (list.length > 1) {
      findings.push({
        code: 'CAGE-DECL-004',
        at: `${list[0].file}:${list[0].line}`,
        reason: `导出名 ${n} 在 ${list.map((s) => s.file).join('、')} 里重复，export * 会把它们都丢掉`,
        fix: '改成不重复的导出名；命令可以用 command(X, { name: "原名" }) 保持能力点不变',
      });
    }
  }
  return { sites, findings, unsafeCount, files: files.map((f) => relative(cfg.root, f).replace(/\\/g, '/')) };
}

/** 有声明文件未被导出：静态扫到的声明必须出现在 domain 入口的导出里 */
export function unexportedFindings(sites: DeclSite[], exported: Set<string>): Finding[] {
  return sites
    .filter((s) => !exported.has(s.exportName))
    .map((s) => ({
      code: 'CAGE-DECL-002',
      at: `${s.file}:${s.line}`,
      reason: `声明 ${s.exportName} 没有从 domain 入口导出，内核和抽取器都看不到它`,
      fix: `在 domain 的 index.ts 里加上 export * from './${s.file
        .split('/')
        .pop()!
        .replace(/\.tsx?$/, '')}'`,
    }));
}
