// Public capability discovery reads installed declarations, never framework implementation bodies.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { abs, type CageConfig } from './config.js';
import { VERSION } from './version.js';

const modules = ['kernel', 'approval', 'connectors', 'client', 'admin', 'files'] as const;
const topics: Record<string, { words: string; guide: string }> = {
  file: { words: '文件 附件 上传 单文件', guide: 'files.md' },
  files: { words: '文件 附件 上传 多文件', guide: 'files.md' },
  FileService: { words: '文件 断点续传 分片 上传 存储', guide: 'files.md' },
  FileStorage: { words: '文件 对象存储 S3 适配器', guide: 'files.md' },
  LocalFileStorage: { words: '文件 本地 私有 存储', guide: 'files.md' },
  FileUploadTask: { words: '文件 上传 暂停 恢复 断点续传', guide: 'files.md' },
  scope: { words: '本人 owner 部门 数据范围 授权', guide: 'architecture.md' },
  reaction: { words: '跨对象 事务 事件 反应 原子', guide: 'primitives.md' },
  reactionEach: { words: '批量 集合 多条 上限 顺序 事务', guide: 'diagnostics.md' },
  approver: { words: '审批 选人 部门负责人 角色', guide: 'primitives.md' },
  connector: { words: '第三方 ERP 外呼 外部', guide: 'primitives.md' },
  command: { words: '命令 写入 校验 业务操作', guide: 'primitives.md' },
  query: { words: '查询 报表 安全读取', guide: 'primitives.md' },
};
const examples: Record<string, string> = {
  scope: "scope.self('applicantId'); scope.deptSubtree('deptId', 'applicantId')",
  reaction: "reaction(OrderApproved, { command: reserve, tx: 'same', map: event => ({ id: event.stockId }) })",
  reactionEach: "reactionEach(Allocated, { command: reserve, tx: 'same', order: 2, maxItems: 20, orderBy: 'id', items: event => event.devices, map: item => ({ id: item.id }) })",
  approver: "step('部门负责人', approver.deptLeader('deptId'))",
  query: "query('recentOrders', { reads: [Order], input: z.object({}), sql: 'select id from safe.order limit 20' })",
};

export function publicCapabilities(cfg: CageConfig, query = '') {
  const requests = [createRequire(abs(cfg, cfg.domain)), createRequire(abs(cfg, `${cfg.contracts}/index.ts`)), createRequire(abs(cfg, `${cfg.web}/package.json`)), createRequire(abs(cfg, 'package.json')), createRequire(import.meta.url)];
  const packages = modules.flatMap<{ name: string; version: string | null; entry: string | null }>(module => {
    const name = `@yss123/cage-${module}`;
    try {
      const workspace = abs(cfg, `packages/${module}/package.json`);
      const resolvers = existsSync(workspace) ? [createRequire(workspace), ...requests] : requests;
      let resolved: string | undefined;
      for (const request of resolvers) {
        try { resolved = request.resolve(name); break; } catch { /* Try the next configured package boundary. */ }
      }
      if (!resolved) return [{ name, version: null, entry: null }];
      const entry = resolved.replace(/\.js$/, '.d.ts');
      const manifest = join(dirname(dirname(entry)), 'package.json');
      if (!existsSync(entry)) return [{ name, version: null, entry: null }];
      return [{ name, version: JSON.parse(readFileSync(manifest, 'utf8')).version as string, entry }];
    } catch { return [{ name, version: null, entry: null }]; }
  });
  const entries = packages.flatMap(p => p.entry ? [p.entry] : []);
  const program = ts.createProgram(entries, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const needle = query.normalize('NFKC').toLowerCase();
  const capabilities = packages.flatMap(pkg => {
    if (!pkg.entry) return [];
    const file = program.getSourceFile(pkg.entry);
    const module = file && checker.getSymbolAtLocation(file);
    if (!module) return [];
    return checker.getExportsOfModule(module).flatMap(symbol => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const declaration = target.declarations?.[0];
      if (!declaration) return [];
      const name = symbol.name;
      const description = ts.displayPartsToString(target.getDocumentationComment(checker));
      const topic = topics[name];
      if (needle && !`${name} ${description} ${topic?.words ?? ''}`.normalize('NFKC').toLowerCase().includes(needle)) return [];
      const type = checker.getTypeOfSymbolAtLocation(target, declaration);
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map(s => checker.signatureToString(s, declaration, ts.TypeFormatFlags.NoTruncation));
      return [{ key: `${pkg.name}#${name}`, package: pkg.name, version: pkg.version, name, public: true, description,
        signatures: signatures.length ? signatures : [declaration.getText().slice(0, 6000)],
        guide: `docs/ai/${topic?.guide ?? 'README.md'}`, example: examples[name] ? { code: examples[name], context: '组合片段；声明中的业务符号须来自当前项目，完整可运行例子见 guide' } : undefined,
        limitations: topic ? ['能力和数据范围仍由实际授权决定；按照当前签名与指南使用。'] : [],
        source: { file: declaration.getSourceFile().fileName, line: declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1 } }];
    });
  });
  return { schemaVersion: 1, cliVersion: VERSION, query, packages: packages.map(({ entry, ...p }) => ({ ...p, inspected: !!entry })), capabilities,
    limitations: ['仅展示当前安装版本的公共导出；签名不代表任意组合均有效。按 guide 查看最小例子、限制及相关错误码。', '未安装的包标为未检查，不据此断言框架不支持。'] };
}
